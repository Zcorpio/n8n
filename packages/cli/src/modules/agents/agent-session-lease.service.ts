import { Logger } from '@n8n/backend-common';
import { TransactionRunner, type OperationContext } from '@n8n/db';
import { Service } from '@n8n/di';
import { InstanceSettings } from 'n8n-core';
import { UnexpectedError } from 'n8n-workflow';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import { AgentSessionLeaseLostError } from './agent-session-lease-lost.error';
import { AgentTurnAlreadyRunningError } from './agent-turn-already-running.error';
import { AgentSessionLeaseRepository } from './repositories/agent-session-lease.repository';

/** Another main can take over a lease that is not renewed within this time. */
export const SESSION_LEASE_TTL_MS = 120_000;

/**
 * How long a resume that a person started waits for the session. It covers
 * the finalization of the turn that suspended, which still holds the lease.
 */
export const INTERACTIVE_RESUME_SESSION_WAIT_MS = 5_000;

/**
 * How long an agent workflow node waits for the session. Executions that share
 * a session ID then run one after the other, and only a long wait fails.
 */
export const WORKFLOW_NODE_SESSION_WAIT_MS = 30_000;

/** Renewals that can fail in a row before the local turn is aborted. */
const MAX_FAILED_RENEWALS = 2;

export interface SessionLeaseRequest {
	threadId: string;
	agentId: string;
	executionId: string;
}

export interface SessionLeaseGrant extends SessionLeaseRequest {
	ownerToken: string;
	epoch: number;
	/** The execution whose expired lease this grant took over, if any. */
	previousExecutionId: string | null;
}

interface HeldLease {
	threadId: string;
	executionId: string;
	ownerToken: string;
	epoch: number;
	controller: AbortController;
	failedRenewals: number;
	renewing: boolean;
	/** The database confirmed that another turn owns the session. */
	lost: boolean;
}

/**
 * Allows one agent turn at a time on a session. The database row decides
 * between mains. The local registry keeps this main from starting a turn on a
 * session while an older local turn on that session is still settling.
 *
 * A turn also fences its writes: the async context of the turn carries its
 * lease, and each fenced write first checks that the lease is still the
 * turn's. The context stays with async work that outlives the turn, so a late
 * write of a settled turn is rejected.
 */
@Service()
export class AgentSessionLeaseService {
	private readonly held = new Map<string, HeldLease>();

	private readonly turnScope = new AsyncLocalStorage<HeldLease>();

	constructor(
		private readonly logger: Logger,
		private readonly repository: AgentSessionLeaseRepository,
		private readonly instanceSettings: InstanceSettings,
		private readonly txRunner: TransactionRunner,
	) {
		this.logger = this.logger.scoped('agents');
	}

	/** Takes the lease in the caller's transaction. Throws when another turn holds the session. */
	async acquire(request: SessionLeaseRequest, ctx: OperationContext): Promise<SessionLeaseGrant> {
		if (this.held.has(request.threadId)) throw new AgentTurnAlreadyRunningError();
		const ownerToken = randomUUID();
		const acquisition = await this.repository.acquire(
			{ ...request, ownerToken, ownerHostId: this.instanceSettings.hostId },
			SESSION_LEASE_TTL_MS,
			ctx,
		);
		if (!acquisition.acquired) throw new AgentTurnAlreadyRunningError();
		const { epoch, previousExecutionId } = acquisition;
		return { ...request, ownerToken, epoch, previousExecutionId };
	}

	/** Tracks a committed lease. The returned signal aborts when the lease is lost. */
	hold(grant: SessionLeaseGrant): AbortSignal {
		const controller = new AbortController();
		this.held.set(grant.threadId, {
			threadId: grant.threadId,
			executionId: grant.executionId,
			ownerToken: grant.ownerToken,
			epoch: grant.epoch,
			controller,
			failedRenewals: 0,
			renewing: false,
			lost: false,
		});
		return controller.signal;
	}

	/** Runs `fn` as part of the turn that holds the lease, so its writes are fenced. */
	runInTurn<T>(threadId: string, executionId: string, fn: () => T): T {
		const lease = this.findHeld(threadId, executionId);
		if (!lease) throw new UnexpectedError('The agent turn holds no session lease');
		return this.turnScope.run(lease, fn);
	}

	/** Runs `fn` outside any turn. Use it for independent work that a turn starts. */
	runOutsideTurn<T>(fn: () => T): T {
		return this.turnScope.exit(fn);
	}

	/**
	 * Runs a write of the current turn after it checks, in the same transaction,
	 * that the turn still owns its session lease. A write outside a turn runs
	 * without the check.
	 */
	async fencedWrite<T>(
		ctx: OperationContext,
		write: (ctx: OperationContext) => Promise<T>,
	): Promise<T> {
		const lease = this.turnScope.getStore();
		if (!lease) return await write(ctx);
		return await this.writeUnderLease(lease, ctx, write);
	}

	/** Like `fencedWrite`, for the turn of the given execution. */
	async fencedWriteFor<T>(
		threadId: string,
		executionId: string,
		ctx: OperationContext,
		write: (ctx: OperationContext) => Promise<T>,
	): Promise<T> {
		const lease = this.findHeld(threadId, executionId);
		if (!lease) throw new AgentSessionLeaseLostError();
		return await this.writeUnderLease(lease, ctx, write);
	}

	/** Extends the lease on each execution heartbeat. Never throws. */
	async renew(threadId: string, executionId: string): Promise<void> {
		const lease = this.findHeld(threadId, executionId);
		if (!lease || lease.controller.signal.aborted) return;
		if (lease.renewing) {
			this.countFailedRenewal(threadId, lease);
			return;
		}
		lease.renewing = true;
		try {
			await this.extend(threadId, lease);
		} finally {
			lease.renewing = false;
		}
	}

	/** Frees the lease. Never throws: a lease that cannot be freed expires. */
	async release(threadId: string, executionId: string): Promise<void> {
		const lease = this.findHeld(threadId, executionId);
		if (!lease) return;
		try {
			await this.repository.release(threadId, lease.ownerToken);
		} catch (error) {
			this.logger.warn('Failed to release an agent session lease', {
				threadId,
				executionId,
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			this.held.delete(threadId);
		}
	}

	private async writeUnderLease<T>(
		lease: HeldLease,
		ctx: OperationContext,
		write: (ctx: OperationContext) => Promise<T>,
	): Promise<T> {
		// The turn has settled, a newer local turn holds the session, or a takeover is confirmed.
		if (this.held.get(lease.threadId) !== lease || lease.lost) {
			throw new AgentSessionLeaseLostError();
		}
		return await this.txRunner.run(ctx, async (trxCtx) => {
			const { threadId, ownerToken, epoch } = lease;
			if (!(await this.repository.isHeldBy(threadId, ownerToken, epoch, trxCtx))) {
				// Abort first: the SDK swallows some write errors, and the abort still stops the run.
				this.loseLease(lease);
				throw new AgentSessionLeaseLostError();
			}
			return await write(trxCtx);
		});
	}

	private async extend(threadId: string, lease: HeldLease): Promise<void> {
		try {
			const renewed = await this.repository.renew(threadId, lease.ownerToken, SESSION_LEASE_TTL_MS);
			if (renewed) {
				lease.failedRenewals = 0;
				return;
			}
			// Another main took over the expired lease.
			this.loseLease(lease);
		} catch (error) {
			this.countFailedRenewal(threadId, lease, error);
		}
	}

	/** A renewal that is still in progress at the next heartbeat also counts as failed. */
	private countFailedRenewal(threadId: string, lease: HeldLease, error?: unknown): void {
		lease.failedRenewals += 1;
		this.logger.warn('Failed to renew an agent session lease', {
			threadId,
			executionId: lease.executionId,
			failedRenewals: lease.failedRenewals,
			...(error !== undefined && {
				error: error instanceof Error ? error.message : String(error),
			}),
		});
		// The lease can still be ours, so fenced writes keep checking the database.
		if (lease.failedRenewals >= MAX_FAILED_RENEWALS) this.abortTurn(lease);
	}

	/** Another turn owns the session. Fenced writes of this turn fail without a check. */
	private loseLease(lease: HeldLease): void {
		lease.lost = true;
		this.abortTurn(lease);
	}

	private abortTurn(lease: HeldLease): void {
		if (lease.controller.signal.aborted) return;
		this.logger.warn('Lost an agent session lease. Aborting the turn.', {
			threadId: lease.threadId,
			executionId: lease.executionId,
		});
		lease.controller.abort(new AgentSessionLeaseLostError());
	}

	private findHeld(threadId: string, executionId: string): HeldLease | undefined {
		const lease = this.held.get(threadId);
		return lease?.executionId === executionId ? lease : undefined;
	}
}
