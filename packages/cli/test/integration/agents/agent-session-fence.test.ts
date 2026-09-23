import type { SerializableAgentState } from '@n8n/agents';
import { createTeamProject, mockLogger, testDb, testModules } from '@n8n/backend-test-utils';
import { AgentsConfig } from '@n8n/config';
import { TransactionRunner, type OperationContext } from '@n8n/db';
import { Container } from '@n8n/di';
import { DataSource } from '@n8n/typeorm';
import type { InstanceSettings } from 'n8n-core';
import { createRequire } from 'node:module';
import { v4 as uuid } from 'uuid';
import { mock } from 'vitest-mock-extended';

import type { ExecutionPersistence } from '@/executions/execution-persistence';
import type { AgentExecutionUpdateBroadcaster } from '@/modules/agents/agent-execution-update-broadcaster';
import { AgentSessionLeaseLostError } from '@/modules/agents/agent-session-lease-lost.error';
import { AgentSessionLeaseService } from '@/modules/agents/agent-session-lease.service';
import { AgentBackgroundJobService } from '@/modules/agents/background/agent-background-job.service';
import type { Agent } from '@/modules/agents/entities/agent.entity';
import { IntegrationMessageContextService } from '@/modules/agents/integrations/integration-message-context.service';
import type { IntegrationMessageContext } from '@/modules/agents/integrations/integration-tool-types';
import { N8NCheckpointStorage } from '@/modules/agents/integrations/n8n-checkpoint-storage';
import { N8nMemory } from '@/modules/agents/integrations/n8n-memory';
import { AgentBackgroundJobRepository } from '@/modules/agents/repositories/agent-background-job.repository';
import { AgentCheckpointRepository } from '@/modules/agents/repositories/agent-checkpoint.repository';
import { AgentExecutionRepository } from '@/modules/agents/repositories/agent-execution.repository';
import { AgentMessageRepository } from '@/modules/agents/repositories/agent-message.repository';
import { AgentResourceRepository } from '@/modules/agents/repositories/agent-resource.repository';
import { AgentSessionLeaseRepository } from '@/modules/agents/repositories/agent-session-lease.repository';
import { AgentThreadRepository } from '@/modules/agents/repositories/agent-thread.repository';
import { AgentRepository } from '@/modules/agents/repositories/agent.repository';
import type { Publisher } from '@/scaling/pubsub/publisher.service';

// Share the transaction class loaded by the built BaseRepository.
const { TypeOrmTransactionRunner } = createRequire(__filename)(
	'@n8n/db/dist/services/typeorm-transaction',
) as typeof import('@n8n/db/dist/services/typeorm-transaction');

/**
 * Each area checks that a turn whose lease another main took over cannot
 * write, and that the same write outside a turn still works. The local side
 * uses the container services, so the adapters share the turn scope of the
 * lease service. The other main runs on a second DataSource.
 */
describe('Fenced agent session writes', () => {
	let agentRepo: AgentRepository;
	let sessionLeases: AgentSessionLeaseService;
	let peer: DataSource;
	let agentId: string;

	beforeAll(async () => {
		await testModules.loadModules(['agents']);
		await testDb.init();
		agentRepo = Container.get(AgentRepository);
		sessionLeases = Container.get(AgentSessionLeaseService);
		// CI runs PostgreSQL with one pooled connection, so the other main needs its own DataSource.
		peer = await new DataSource({
			...agentRepo.manager.connection.options,
			synchronize: false,
			migrationsRun: false,
			dropSchema: false,
		}).initialize();
	});

	beforeEach(async () => {
		const project = await createTeamProject();
		const agent = agentRepo.create({
			id: uuid(),
			name: 'Test Agent',
			projectId: project.id,
			integrations: [],
			tools: {},
			skills: {},
		} as Partial<Agent>);
		await agentRepo.save(agent);
		agentId = agent.id;
	});

	afterEach(async () => {
		await Container.get(AgentBackgroundJobRepository).delete({});
		await Container.get(AgentThreadRepository).delete({});
		await Container.get(AgentResourceRepository).delete({});
		await agentRepo.delete({});
	});

	afterAll(async () => {
		if (peer?.isInitialized) await peer.destroy();
		await testDb.terminate();
	});

	/** Starts a turn on this main, then lets another main take over its expired lease. */
	async function startStaleTurn(threadId: string) {
		const executionId = uuid();
		const grant = await Container.get(TransactionRunner).run(
			{},
			async (ctx: OperationContext) =>
				await sessionLeases.acquire({ threadId, agentId, executionId }, ctx),
		);
		sessionLeases.hold(grant);
		await Container.get(AgentSessionLeaseRepository).update(
			{ threadId },
			{ expiresAt: new Date(0) },
		);

		const peerRunner = new TypeOrmTransactionRunner(peer, mockLogger());
		const otherMain = new AgentSessionLeaseService(
			mockLogger(),
			new AgentSessionLeaseRepository(peer, peerRunner),
			mock<InstanceSettings>({ hostId: 'main-b' }),
			peerRunner,
		);
		await peerRunner.run(
			{},
			async (ctx: OperationContext) =>
				await otherMain.acquire({ threadId, agentId, executionId: uuid() }, ctx),
		);

		return {
			write: async <T>(fn: () => Promise<T>) =>
				await sessionLeases.runInTurn(threadId, executionId, fn),
			settle: async () => await sessionLeases.release(threadId, executionId),
		};
	}

	describe('memory transcript', () => {
		it('rejects the transcript writes of a turn whose lease another main took over', async () => {
			const threadId = uuid();
			const staleTurn = await startStaleTurn(threadId);
			const memory = Container.get(N8nMemory).getImplementation(agentId);
			const messages = Container.get(AgentMessageRepository);
			const message = {
				id: uuid(),
				createdAt: new Date(),
				role: 'user' as const,
				content: [{ type: 'text' as const, text: 'Hello' }],
			};
			const thread = { id: threadId, resourceId: 'user-1' };

			await expect(staleTurn.write(async () => await memory.saveThread(thread))).rejects.toThrow(
				AgentSessionLeaseLostError,
			);
			await expect(
				staleTurn.write(
					async () => await memory.saveMessages({ ...thread, threadId, messages: [message] }),
				),
			).rejects.toThrow(AgentSessionLeaseLostError);
			await expect(
				staleTurn.write(async () => await memory.deleteMessages([message.id])),
			).rejects.toThrow(AgentSessionLeaseLostError);
			expect(await Container.get(AgentThreadRepository).findOneBy({ id: threadId })).toBeNull();

			await memory.saveThread(thread);
			await memory.saveMessages({ ...thread, threadId, messages: [message] });
			expect(await messages.countBy({ threadId })).toBe(1);
			await memory.deleteMessages([message.id]);
			expect(await messages.countBy({ threadId })).toBe(0);

			await staleTurn.settle();
		});
	});

	describe('checkpoints', () => {
		const suspendedState = (threadId: string): SerializableAgentState => ({
			status: 'suspended',
			persistence: { threadId, resourceId: 'user-1' },
			messageList: { messages: [], historyIds: [], inputIds: [], responseIds: [] },
			pendingToolCalls: {},
		});

		it('rejects the checkpoint writes of a turn whose lease another main took over', async () => {
			const threadId = uuid();
			const state = suspendedState(threadId);
			const checkpoints = Container.get(AgentCheckpointRepository);
			const storage = Container.get(N8NCheckpointStorage);
			const store = storage.getStorage(agentId);
			await store.save('run-parked', state);
			const staleTurn = await startStaleTurn(threadId);

			await expect(staleTurn.write(async () => await store.save('run-new', state))).rejects.toThrow(
				AgentSessionLeaseLostError,
			);
			await expect(
				staleTurn.write(async () => await store.claimForResume?.('run-parked', state)),
			).rejects.toThrow(AgentSessionLeaseLostError);
			await expect(
				staleTurn.write(async () => await storage.cancelSuspended('run-parked', state, agentId)),
			).rejects.toThrow(AgentSessionLeaseLostError);
			await expect(staleTurn.write(async () => await store.delete('run-parked'))).rejects.toThrow(
				AgentSessionLeaseLostError,
			);
			expect(await checkpoints.findByRunId('run-new')).toBeNull();
			expect(await storage.getStatus('run-parked', agentId)).toEqual({
				status: 'active',
				checkpoint: state,
			});

			await expect(store.claimForResume?.('run-parked', state)).resolves.toBe(true);
			await store.delete('run-parked');
			expect(await storage.getStatus('run-parked', agentId)).toEqual({ status: 'expired' });

			await staleTurn.settle();
		});
	});

	describe('background jobs', () => {
		it('rejects the job writes of a turn whose lease another main took over', async () => {
			const threadId = uuid();
			const jobRows = Container.get(AgentBackgroundJobRepository);
			const jobs = new AgentBackgroundJobService(
				jobRows,
				Container.get(AgentExecutionRepository),
				mock<ExecutionPersistence>(),
				mock<Publisher>(),
				mockLogger(),
				Container.get(AgentsConfig),
				mock<AgentExecutionUpdateBroadcaster>(),
				sessionLeases,
			);
			const parent = {
				parentAgentId: agentId,
				parentThreadId: threadId,
				parentResourceId: 'user-1',
				parentPrincipalHash: 'principal-hash',
			};
			const subAgentJob = {
				...parent,
				id: uuid(),
				title: 'Research',
				subAgentId: 'sub-agent-1',
				childThreadId: uuid(),
			};
			const workflowJob = {
				...parent,
				id: uuid(),
				title: 'Lookup',
				workflowId: 'workflow-1',
				executionId: 'execution-1',
			};
			const staleTurn = await startStaleTurn(threadId);

			await expect(
				staleTurn.write(async () => await jobs.registerSubAgentJob(subAgentJob)),
			).rejects.toThrow(AgentSessionLeaseLostError);
			await expect(
				staleTurn.write(async () => await jobs.registerWorkflowJob(workflowJob)),
			).rejects.toThrow(AgentSessionLeaseLostError);
			await expect(
				staleTurn.write(async () => await jobs.markMailConsumed(threadId, [subAgentJob.id])),
			).rejects.toThrow(AgentSessionLeaseLostError);
			expect(await jobRows.countBy({ parentThreadId: threadId })).toBe(0);

			await expect(jobs.registerSubAgentJob(subAgentJob)).resolves.toEqual({
				status: 'started',
				jobId: subAgentJob.id,
			});
			await expect(jobs.registerWorkflowJob(workflowJob)).resolves.toEqual({
				status: 'started',
				jobId: workflowJob.id,
			});
			// The jobs are still running, so there are no results to mark.
			await expect(jobs.markMailConsumed(threadId, [subAgentJob.id])).resolves.toBe(0);

			await staleTurn.settle();
		});
	});

	describe('message context', () => {
		it('rejects the message context writes of a turn whose lease another main took over', async () => {
			const threadId = uuid();
			const contexts = Container.get(IntegrationMessageContextService);
			const context: IntegrationMessageContext = {
				integrationConnectionId: 'slack:cred-1',
				platform: 'slack',
				target: { type: 'thread', threadId: 'slack:C1:1.1' },
				messageId: '1.1',
				updatedAt: '2026-09-23T10:00:00.000Z',
			};
			const origin = { threadId, resourceId: 'task:task-1' };
			const derivedThreadId = `${agentId}:slack:C2:2.2`;
			const staleTurn = await startStaleTurn(threadId);

			await expect(
				staleTurn.write(async () => await contexts.setLatest(threadId, 'user-1', context)),
			).rejects.toThrow(AgentSessionLeaseLostError);
			await expect(
				staleTurn.write(async () => await contexts.bindSession(derivedThreadId, origin)),
			).rejects.toThrow(AgentSessionLeaseLostError);
			// The claim of a resume logs a failed write and does not throw.
			await staleTurn.write(async () => await contexts.installIncoming(context, origin, origin));
			expect(await contexts.getLatest(threadId)).toBeNull();
			expect(await contexts.resolveSession(derivedThreadId)).toBeNull();

			await contexts.setLatest(threadId, 'user-1', context);
			await contexts.bindSession(derivedThreadId, origin);
			expect(await contexts.getLatest(threadId)).toEqual(context);
			expect(await contexts.resolveSession(derivedThreadId)).toEqual(origin);

			await staleTurn.settle();
		});
	});
});
