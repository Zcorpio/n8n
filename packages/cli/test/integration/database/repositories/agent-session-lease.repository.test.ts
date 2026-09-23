import { createTeamProject, mockLogger, testDb, testModules } from '@n8n/backend-test-utils';
import type { OperationContext } from '@n8n/db';
import { Container } from '@n8n/di';
import { DataSource } from '@n8n/typeorm';
import { createDeferredPromise } from '@n8n/utils/promise/deferred-promise';
import type { InstanceSettings } from 'n8n-core';
import { createRequire } from 'node:module';
import { v4 as uuid } from 'uuid';
import { mock } from 'vitest-mock-extended';

import { AgentSessionLeaseLostError } from '@/modules/agents/agent-session-lease-lost.error';
import { AgentSessionLeaseService } from '@/modules/agents/agent-session-lease.service';
import type { Agent } from '@/modules/agents/entities/agent.entity';
import { AgentExecutionThreadRepository } from '@/modules/agents/repositories/agent-execution-thread.repository';
import {
	AgentSessionLeaseRepository,
	type SessionLeaseClaim,
} from '@/modules/agents/repositories/agent-session-lease.repository';
import { AgentRepository } from '@/modules/agents/repositories/agent.repository';

// Share the transaction class loaded by the built BaseRepository.
const { TypeOrmTransactionRunner } = createRequire(__filename)(
	'@n8n/db/dist/services/typeorm-transaction',
) as typeof import('@n8n/db/dist/services/typeorm-transaction');

const TTL_MS = 60_000;

const isPostgres = process.env.DB_TYPE === 'postgresdb';

describe('AgentSessionLeaseRepository', () => {
	let agentRepo: AgentRepository;
	let threadRepo: AgentExecutionThreadRepository;
	let peer: DataSource;
	let agentId: string;
	let projectId: string;

	beforeAll(async () => {
		await testModules.loadModules(['agents']);
		await testDb.init();
		agentRepo = Container.get(AgentRepository);
		threadRepo = Container.get(AgentExecutionThreadRepository);
		// CI runs PostgreSQL with one pooled connection, so contention needs a second DataSource.
		peer = await new DataSource({
			...agentRepo.manager.connection.options,
			synchronize: false,
			migrationsRun: false,
			dropSchema: false,
		}).initialize();
	});

	beforeEach(async () => {
		const project = await createTeamProject();
		projectId = project.id;
		const agent = agentRepo.create({
			id: uuid(),
			name: 'Test Agent',
			projectId,
			integrations: [],
			tools: {},
			skills: {},
		} as Partial<Agent>);
		await agentRepo.save(agent);
		agentId = agent.id;
	});

	afterEach(async () => {
		await threadRepo.delete({});
		await agentRepo.delete({});
	});

	afterAll(async () => {
		if (peer?.isInitialized) await peer.destroy();
		await testDb.terminate();
	});

	function leasesOn(connection: DataSource) {
		const txRunner = new TypeOrmTransactionRunner(connection, mockLogger());
		const repository = new AgentSessionLeaseRepository(connection, txRunner);
		const acquire = async (claim: SessionLeaseClaim, ttlMs = TTL_MS) =>
			await txRunner.run(
				{},
				async (ctx: OperationContext) => await repository.acquire(claim, ttlMs, ctx),
			);
		return { repository, acquire };
	}

	function claimFor(threadId: string, executionId = uuid()): SessionLeaseClaim {
		return { threadId, agentId, executionId, ownerToken: uuid(), ownerHostId: 'main-test' };
	}

	it.each(['a new session', 'a released session'])(
		'gives the lease of %s to exactly one of two connections',
		async (session) => {
			const threadId = uuid();
			const local = leasesOn(agentRepo.manager.connection);
			const remote = leasesOn(peer);
			if (session === 'a released session') {
				const claim = claimFor(threadId);
				await local.acquire(claim);
				await local.repository.release(threadId, claim.ownerToken);
			}

			const results = await Promise.all([
				local.acquire(claimFor(threadId)),
				remote.acquire(claimFor(threadId)),
			]);

			expect(results.filter(({ acquired }) => acquired)).toHaveLength(1);
		},
	);

	it('increments the epoch on each acquisition and keeps it after release', async () => {
		const threadId = uuid();
		const { repository, acquire } = leasesOn(agentRepo.manager.connection);
		const first = claimFor(threadId);
		const second = claimFor(threadId);

		expect(await acquire(first)).toMatchObject({ acquired: true, epoch: 1 });
		expect(await repository.release(threadId, first.ownerToken)).toBe(true);
		expect(await acquire(second)).toMatchObject({ acquired: true, epoch: 2 });
		expect(await repository.release(threadId, second.ownerToken)).toBe(true);

		expect(await repository.findOneByOrFail({ threadId })).toMatchObject({
			epoch: 2,
			ownerToken: null,
			ownerHostId: null,
			executionId: null,
			expiresAt: null,
		});
	});

	it('keeps an unexpired lease busy and lets another main take over an expired one', async () => {
		const threadId = uuid();
		const local = leasesOn(agentRepo.manager.connection);
		const remote = leasesOn(peer);
		const holder = claimFor(threadId);
		await local.acquire(holder);

		expect(await remote.acquire(claimFor(threadId))).toEqual({ acquired: false });

		await local.repository.release(threadId, holder.ownerToken);
		const expired = claimFor(threadId);
		// A negative TTL sets the expiry in the past on the database clock.
		await local.acquire(expired, -1_000);
		const takeover = claimFor(threadId);

		expect(await remote.acquire(takeover)).toEqual({
			acquired: true,
			epoch: 3,
			previousExecutionId: expired.executionId,
		});
		expect(await remote.repository.findOneByOrFail({ threadId })).toMatchObject({
			ownerToken: takeover.ownerToken,
			executionId: takeover.executionId,
		});
	});

	it('refuses to renew or release a lease with a stale token', async () => {
		const threadId = uuid();
		const local = leasesOn(agentRepo.manager.connection);
		const remote = leasesOn(peer);
		const stale = claimFor(threadId);
		await local.acquire(stale, -1_000);
		const current = claimFor(threadId);
		await remote.acquire(current);

		expect(await local.repository.renew(threadId, stale.ownerToken, TTL_MS)).toBe(false);
		expect(await local.repository.release(threadId, stale.ownerToken)).toBe(false);
		expect(await remote.repository.renew(threadId, current.ownerToken, TTL_MS)).toBe(true);
		expect(await remote.repository.findOneByOrFail({ threadId })).toMatchObject({
			ownerToken: current.ownerToken,
		});
	});

	it('keeps the lease row when the session is deleted and deletes it with the agent', async () => {
		const threadId = uuid();
		const { repository, acquire } = leasesOn(agentRepo.manager.connection);
		await threadRepo.save(
			threadRepo.create({
				accessScope: 'project',
				id: threadId,
				agentId,
				agentName: 'Test Agent',
				projectId,
				sessionNumber: 1,
			}),
		);
		const claim = claimFor(threadId);
		await acquire(claim);
		await repository.release(threadId, claim.ownerToken);

		await threadRepo.delete({ id: threadId });
		expect(await repository.findOneBy({ threadId })).toMatchObject({ epoch: 1 });

		await agentRepo.delete({ id: agentId });
		expect(await repository.findOneBy({ threadId })).toBeNull();
	});

	describe('fenced writes', () => {
		function sessionsOn(connection: DataSource, hostId: string) {
			const txRunner = new TypeOrmTransactionRunner(connection, mockLogger());
			const repository = new AgentSessionLeaseRepository(connection, txRunner);
			const service = new AgentSessionLeaseService(
				mockLogger(),
				repository,
				mock<InstanceSettings>({ hostId }),
				txRunner,
			);
			const startTurn = async (threadId: string, executionId = uuid()) => {
				const grant = await txRunner.run(
					{},
					async (ctx: OperationContext) =>
						await service.acquire({ threadId, agentId, executionId }, ctx),
				);
				return { executionId, signal: service.hold(grant) };
			};
			const writeInTurn = async <T>(
				threadId: string,
				executionId: string,
				write: () => Promise<T>,
			) =>
				await service.runInTurn(
					threadId,
					executionId,
					async () => await service.fencedWrite({}, write),
				);
			return { service, repository, startTurn, writeInTurn };
		}

		/** Sets the expiry in the past, so another main can take the lease over. */
		async function expireLease(repository: AgentSessionLeaseRepository, threadId: string) {
			await repository.update({ threadId }, { expiresAt: new Date(0) });
		}

		it('rejects the writes of a turn whose lease another main took over', async () => {
			const threadId = uuid();
			const local = sessionsOn(agentRepo.manager.connection, 'main-a');
			const remote = sessionsOn(peer, 'main-b');
			const stale = await local.startTurn(threadId);
			await expireLease(local.repository, threadId);
			const current = await remote.startTurn(threadId);
			const write = vi.fn(async () => 'written');

			await expect(local.writeInTurn(threadId, stale.executionId, write)).rejects.toBeInstanceOf(
				AgentSessionLeaseLostError,
			);
			expect(stale.signal.aborted).toBe(true);
			expect(write).not.toHaveBeenCalled();

			await expect(remote.writeInTurn(threadId, current.executionId, write)).resolves.toBe(
				'written',
			);
			await expect(local.service.fencedWrite({}, write)).resolves.toBe('written');
		});

		it.skipIf(!isPostgres)(
			'makes a takeover wait until a fenced write in progress commits',
			async () => {
				const threadId = uuid();
				const local = sessionsOn(agentRepo.manager.connection, 'main-a');
				const remote = sessionsOn(peer, 'main-b');
				const stale = await local.startTurn(threadId);
				await expireLease(local.repository, threadId);
				const writeStarted = createDeferredPromise();
				const commitWrite = createDeferredPromise();
				const writing = local.writeInTurn(threadId, stale.executionId, async () => {
					writeStarted.resolve();
					await commitWrite.promise;
				});
				await writeStarted.promise;

				let tookOver = false;
				const takeover = remote.startTurn(threadId).then(() => {
					tookOver = true;
				});
				await new Promise((resolve) => setTimeout(resolve, 200));
				expect(tookOver).toBe(false);

				commitWrite.resolve();
				await writing;
				await takeover;

				await expect(
					local.writeInTurn(threadId, stale.executionId, async () => 'late'),
				).rejects.toBeInstanceOf(AgentSessionLeaseLostError);
			},
		);
	});
});
