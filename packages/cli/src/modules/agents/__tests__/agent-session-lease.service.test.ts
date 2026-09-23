import { mockLogger } from '@n8n/backend-test-utils';
import type { OperationContext, Transaction, TransactionRunner } from '@n8n/db';
import { createDeferredPromise } from '@n8n/utils/promise/deferred-promise';
import type { InstanceSettings } from 'n8n-core';
import { mock } from 'vitest-mock-extended';

import { AgentSessionLeaseLostError } from '../agent-session-lease-lost.error';
import { AgentSessionLeaseService } from '../agent-session-lease.service';
import { AgentTurnAlreadyRunningError } from '../agent-turn-already-running.error';
import type { AgentSessionLeaseRepository } from '../repositories/agent-session-lease.repository';

const request = { threadId: 'thread-1', agentId: 'agent-1', executionId: 'execution-1' };
const ctx: OperationContext = {};
const trxCtx: OperationContext = { trx: mock<Transaction>() };

describe('AgentSessionLeaseService', () => {
	const repository = mock<AgentSessionLeaseRepository>();
	const txRunner = mock<TransactionRunner>();
	let service: AgentSessionLeaseService;

	beforeEach(() => {
		vi.clearAllMocks();
		repository.acquire.mockResolvedValue({ acquired: true, epoch: 3, previousExecutionId: null });
		repository.renew.mockResolvedValue(true);
		repository.release.mockResolvedValue(true);
		repository.isHeldBy.mockResolvedValue(true);
		txRunner.run.mockImplementation(async (_ctx, fn) => await fn(trxCtx));
		service = new AgentSessionLeaseService(
			mockLogger(),
			repository,
			mock<InstanceSettings>({ hostId: 'main-1' }),
			txRunner,
		);
	});

	async function holdLease() {
		const grant = await service.acquire(request, ctx);
		return { grant, signal: service.hold(grant) };
	}

	it('acquires the lease for this main and returns the grant', async () => {
		repository.acquire.mockResolvedValue({
			acquired: true,
			epoch: 4,
			previousExecutionId: 'execution-0',
		});

		const grant = await service.acquire(request, ctx);

		expect(repository.acquire).toHaveBeenCalledWith(
			expect.objectContaining({ ...request, ownerHostId: 'main-1', ownerToken: grant.ownerToken }),
			120_000,
			ctx,
		);
		expect(grant).toMatchObject({ ...request, epoch: 4, previousExecutionId: 'execution-0' });
	});

	it('rejects as busy when another turn holds the session', async () => {
		repository.acquire.mockResolvedValue({ acquired: false });

		await expect(service.acquire(request, ctx)).rejects.toBeInstanceOf(
			AgentTurnAlreadyRunningError,
		);
	});

	it('refuses a session while an older local turn on it is still settling', async () => {
		await holdLease();

		await expect(
			service.acquire({ ...request, executionId: 'execution-2' }, ctx),
		).rejects.toBeInstanceOf(AgentTurnAlreadyRunningError);
		expect(repository.acquire).toHaveBeenCalledOnce();
	});

	it('aborts the turn after two failed renewals in a row', async () => {
		const { signal } = await holdLease();
		repository.renew.mockRejectedValue(new Error('database unavailable'));

		await service.renew(request.threadId, request.executionId);
		expect(signal.aborted).toBe(false);
		await service.renew(request.threadId, request.executionId);

		expect(signal.aborted).toBe(true);
		expect(signal.reason).toBeInstanceOf(AgentSessionLeaseLostError);
		expect(service.isLost(request.threadId, request.executionId)).toBe(true);
	});

	it('counts a renewal that is still in progress at the next heartbeat as failed', async () => {
		const { signal } = await holdLease();
		const pending = createDeferredPromise<boolean>();
		repository.renew.mockReturnValueOnce(pending.promise);

		const firstRenewal = service.renew(request.threadId, request.executionId);
		await service.renew(request.threadId, request.executionId);
		await service.renew(request.threadId, request.executionId);

		expect(signal.aborted).toBe(true);
		pending.resolve(true);
		await firstRenewal;
	});

	it('aborts the turn at once when another main took over the lease', async () => {
		const { signal } = await holdLease();
		repository.renew.mockResolvedValue(false);

		await service.renew(request.threadId, request.executionId);

		expect(signal.reason).toBeInstanceOf(AgentSessionLeaseLostError);
	});

	it('resets the failure count after a successful renewal', async () => {
		const { signal } = await holdLease();
		repository.renew
			.mockRejectedValueOnce(new Error('database unavailable'))
			.mockResolvedValueOnce(true)
			.mockRejectedValueOnce(new Error('database unavailable'));

		await service.renew(request.threadId, request.executionId);
		await service.renew(request.threadId, request.executionId);
		await service.renew(request.threadId, request.executionId);

		expect(signal.aborted).toBe(false);
	});

	it('frees the local slot even when the release query fails', async () => {
		const { grant } = await holdLease();
		repository.release.mockRejectedValue(new Error('database unavailable'));

		await service.release(request.threadId, request.executionId);

		expect(repository.release).toHaveBeenCalledWith(request.threadId, grant.ownerToken);
		await expect(service.acquire(request, ctx)).resolves.toMatchObject(request);
	});

	it('ignores renewals and releases for an execution that does not hold the lease', async () => {
		await holdLease();

		await service.renew(request.threadId, 'other-execution');
		await service.release(request.threadId, 'other-execution');

		expect(repository.renew).not.toHaveBeenCalled();
		expect(repository.release).not.toHaveBeenCalled();
	});

	describe('fenced writes', () => {
		const write = vi.fn(async (_ctx: OperationContext) => 'written');

		const writeInTurn = async (executionId = request.executionId) =>
			await service.runInTurn(
				request.threadId,
				executionId,
				async () => await service.fencedWrite(ctx, write),
			);

		it('runs a write outside a turn without the check', async () => {
			await expect(service.fencedWrite(ctx, write)).resolves.toBe('written');

			expect(write).toHaveBeenCalledWith(ctx);
			expect(txRunner.run).not.toHaveBeenCalled();
		});

		it('checks the lease of the turn in the transaction of the write', async () => {
			const { grant } = await holdLease();

			await expect(writeInTurn()).resolves.toBe('written');

			expect(repository.isHeldBy).toHaveBeenCalledWith(
				request.threadId,
				grant.ownerToken,
				3,
				trxCtx,
			);
			expect(write).toHaveBeenCalledWith(trxCtx);
		});

		it('rejects the write and aborts the turn when another turn owns the session', async () => {
			const { signal } = await holdLease();
			repository.isHeldBy.mockResolvedValue(false);

			await expect(writeInTurn()).rejects.toBeInstanceOf(AgentSessionLeaseLostError);

			expect(signal.aborted).toBe(true);
			expect(write).not.toHaveBeenCalled();
			// The loss is confirmed, so the next write fails without another check.
			repository.isHeldBy.mockClear();
			await expect(writeInTurn()).rejects.toBeInstanceOf(AgentSessionLeaseLostError);
			expect(repository.isHeldBy).not.toHaveBeenCalled();
		});

		it('fails a write without the check after another main took over the lease', async () => {
			await holdLease();
			repository.renew.mockResolvedValue(false);
			await service.renew(request.threadId, request.executionId);

			await expect(
				service.fencedWriteFor(request.threadId, request.executionId, ctx, write),
			).rejects.toBeInstanceOf(AgentSessionLeaseLostError);

			expect(repository.isHeldBy).not.toHaveBeenCalled();
		});

		it('keeps checking the database after two failed renewals', async () => {
			const { signal } = await holdLease();
			repository.renew.mockRejectedValue(new Error('database unavailable'));
			await service.renew(request.threadId, request.executionId);
			await service.renew(request.threadId, request.executionId);
			expect(signal.aborted).toBe(true);

			await expect(
				service.fencedWriteFor(request.threadId, request.executionId, ctx, write),
			).resolves.toBe('written');

			expect(repository.isHeldBy).toHaveBeenCalledOnce();
		});

		it('rejects a late write of a settled turn while a newer turn holds the session', async () => {
			await holdLease();
			const turnSettled = createDeferredPromise();
			const lateWrite = service.runInTurn(request.threadId, request.executionId, async () => {
				await turnSettled.promise;
				return await service.fencedWrite(ctx, write);
			});
			await service.release(request.threadId, request.executionId);
			service.hold(await service.acquire({ ...request, executionId: 'execution-2' }, ctx));
			turnSettled.resolve();

			await expect(lateWrite).rejects.toBeInstanceOf(AgentSessionLeaseLostError);

			expect(repository.isHeldBy).not.toHaveBeenCalled();
			expect(write).not.toHaveBeenCalled();
		});

		it('runs a write without the check when a turn starts independent work', async () => {
			await holdLease();

			await service.runInTurn(
				request.threadId,
				request.executionId,
				async () => await service.runOutsideTurn(async () => await service.fencedWrite(ctx, write)),
			);

			expect(txRunner.run).not.toHaveBeenCalled();
			expect(write).toHaveBeenCalledWith(ctx);
		});
	});
});
