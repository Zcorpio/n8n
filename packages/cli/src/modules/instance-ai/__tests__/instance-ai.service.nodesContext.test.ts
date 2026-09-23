import type {
	InstanceAiAgentAttachment,
	InstanceAiNodesAttachment,
	InstanceAiResourceAttachment,
	InstanceAiWorkflowAttachment,
} from '@n8n/api-types';
import type { User } from '@n8n/db';
import type { Mock } from 'vitest';

import { InstanceAiService } from '../instance-ai.service';

function nodesAttachment(
	overrides: Partial<InstanceAiNodesAttachment> = {},
): InstanceAiNodesAttachment {
	return {
		type: 'nodes',
		workflowId: 'wf-1',
		sets: [{ nodes: [{ id: 'n1', name: 'HTTP Request' }] }],
		...overrides,
	};
}

describe('InstanceAiService — resolveContextAttachments gating', () => {
	type GatedService = {
		nodeContextFlagGate: { isEnabled: Mock };
		resolveContextAttachments: (
			attachments: InstanceAiResourceAttachment[] | undefined,
			user: User,
		) => Promise<InstanceAiResourceAttachment[]>;
	};

	function createService(isEnabled: Mock): GatedService {
		const service = Object.create(InstanceAiService.prototype) as GatedService;
		service.nodeContextFlagGate = { isEnabled };
		return service;
	}

	const user = { id: 'user-1' } as User;

	it('includes the nodes attachment when the flag is on', async () => {
		const service = createService(vi.fn().mockResolvedValue(true));

		const result = await service.resolveContextAttachments([nodesAttachment()], user);

		expect(result).toEqual([nodesAttachment()]);
	});

	it('drops the nodes attachment when the flag is off, without throwing', async () => {
		const service = createService(vi.fn().mockResolvedValue(false));

		const result = await service.resolveContextAttachments([nodesAttachment()], user);

		expect(result).toEqual([]);
	});

	it('keeps workflow and agent attachments without asking the node-context gate', async () => {
		const isEnabled = vi.fn().mockResolvedValue(true);
		const service = createService(isEnabled);
		const workflowAttachment: InstanceAiWorkflowAttachment = { type: 'workflow', id: 'wf-1' };
		const agentAttachment: InstanceAiAgentAttachment = {
			type: 'agent',
			id: 'agent-1',
			projectId: 'project-1',
		};

		const result = await service.resolveContextAttachments(
			[workflowAttachment, agentAttachment],
			user,
		);

		expect(result).toEqual([workflowAttachment, agentAttachment]);
		expect(isEnabled).not.toHaveBeenCalled();
	});

	it('keeps a workflow attachment alongside an enabled nodes attachment', async () => {
		const service = createService(vi.fn().mockResolvedValue(true));
		const workflowAttachment: InstanceAiWorkflowAttachment = { type: 'workflow', id: 'wf-1' };

		const result = await service.resolveContextAttachments(
			[workflowAttachment, nodesAttachment()],
			user,
		);

		expect(result).toEqual([workflowAttachment, nodesAttachment()]);
	});
});
