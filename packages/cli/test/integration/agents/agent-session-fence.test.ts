import { createTeamProject, mockLogger, testDb, testModules } from '@n8n/backend-test-utils';
import { TransactionRunner, type OperationContext } from '@n8n/db';
import { Container } from '@n8n/di';
import { DataSource } from '@n8n/typeorm';
import type { InstanceSettings } from 'n8n-core';
import { createRequire } from 'node:module';
import { v4 as uuid } from 'uuid';
import { mock } from 'vitest-mock-extended';

import { AgentSessionLeaseLostError } from '@/modules/agents/agent-session-lease-lost.error';
import { AgentSessionLeaseService } from '@/modules/agents/agent-session-lease.service';
import type { Agent } from '@/modules/agents/entities/agent.entity';
import { N8nMemory } from '@/modules/agents/integrations/n8n-memory';
import { AgentMessageRepository } from '@/modules/agents/repositories/agent-message.repository';
import { AgentResourceRepository } from '@/modules/agents/repositories/agent-resource.repository';
import { AgentSessionLeaseRepository } from '@/modules/agents/repositories/agent-session-lease.repository';
import { AgentThreadRepository } from '@/modules/agents/repositories/agent-thread.repository';
import { AgentRepository } from '@/modules/agents/repositories/agent.repository';

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
});
