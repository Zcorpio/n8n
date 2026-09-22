import { defineComponent } from 'vue';
import { render } from '@testing-library/vue';
import userEvent from '@testing-library/user-event';
import { createTestingPinia } from '@pinia/testing';
import { setActivePinia } from 'pinia';
import type { PolicyViolation } from '@n8n/api-types';
import { ResponseError } from '@n8n/rest-api-client';

import { createTestNode, createTestWorkflow, mockNodeTypeDescription } from '@/__tests__/mocks';
import { mockedStore } from '@/__tests__/utils';
import { useNodeTypesStore } from '@/app/stores/nodeTypes.store';
import { canvasEventBus } from '@/features/workflows/canvas/canvas.eventBus';
import { useWorkflowsStore } from '@/app/stores/workflows.store';
import {
	createWorkflowDocumentId,
	useWorkflowDocumentStore,
} from '@/app/stores/workflowDocument.store';
import { usePolicyViolationToast } from './usePolicyViolationToast';

const showMessageSpy = vi.hoisted(() => vi.fn());

vi.mock('@n8n/composables/useToast', () => ({
	useToast: () => ({ showMessage: showMessageSpy }),
}));

const SLACK_NODE_TYPE = 'n8n-nodes-base.slack';

const slackViolation: PolicyViolation = {
	kind: 'node-type-unavailable',
	checkId: 'node-type-availability',
	message: `Node type "${SLACK_NODE_TYPE}" is blocked by an instance policy`,
	subject: SLACK_NODE_TYPE,
	subjectType: 'nodeType',
	scope: 'instance',
};

function refusedWith(violations: PolicyViolation[]) {
	return new ResponseError('Blocked by an instance policy', {
		httpStatusCode: 403,
		meta: { violations },
	});
}

function prepareWorkflowWithTwoSlackNodes() {
	const workflow = createTestWorkflow({
		id: 'w1',
		nodes: [
			createTestNode({ id: 'slack-1', name: 'Slack', type: SLACK_NODE_TYPE }),
			createTestNode({ id: 'set-1', name: 'Set', type: 'n8n-nodes-base.set' }),
			createTestNode({ id: 'slack-2', name: 'Slack1', type: SLACK_NODE_TYPE }),
		],
	});

	useWorkflowsStore().setWorkflowId(workflow.id);
	useWorkflowDocumentStore(createWorkflowDocumentId(workflow.id)).hydrate(workflow);
}

function registerSlackNodeType() {
	mockedStore(useNodeTypesStore).getNodeType = vi
		.fn()
		.mockReturnValue(mockNodeTypeDescription({ name: SLACK_NODE_TYPE, displayName: 'Slack' }));
}

describe('usePolicyViolationToast', () => {
	beforeEach(() => {
		setActivePinia(createTestingPinia({ stubActions: false }));
		showMessageSpy.mockClear();
	});

	it('shows one toast that jumps to every node of the refused type', async () => {
		prepareWorkflowWithTwoSlackNodes();
		registerSlackNodeType();
		const emitSpy = vi.spyOn(canvasEventBus, 'emit');

		const { showPolicyViolationToast } = usePolicyViolationToast();

		expect(showPolicyViolationToast(refusedWith([slackViolation]), 'Problem saving')).toBe(true);
		expect(showMessageSpy).toHaveBeenCalledTimes(1);

		const toastOptions = showMessageSpy.mock.calls[0][0];
		expect(toastOptions).toMatchObject({ title: 'Problem saving', type: 'error', duration: 0 });

		const { getByTestId } = render(defineComponent({ render: () => toastOptions.message }));
		expect(getByTestId('policy-violation')).toHaveTextContent("Node type 'Slack'");

		await userEvent.click(getByTestId('policy-violation-jump'));

		expect(emitSpy).toHaveBeenCalledWith('nodes:select', {
			ids: ['slack-1', 'slack-2'],
			panIntoView: true,
		});
	});

	it('offers no jump when the open workflow holds no node of the refused type', () => {
		useWorkflowsStore().setWorkflowId('w-empty');

		const { showPolicyViolationToast } = usePolicyViolationToast();

		expect(showPolicyViolationToast(refusedWith([slackViolation]), 'Problem saving')).toBe(true);

		const { queryByTestId } = render(
			defineComponent({ render: () => showMessageSpy.mock.calls[0][0].message }),
		);
		expect(queryByTestId('policy-violation-jump')).not.toBeInTheDocument();
	});

	it('leaves an error without violations to the caller', () => {
		const { showPolicyViolationToast } = usePolicyViolationToast();

		expect(
			showPolicyViolationToast(new ResponseError('Bad request', { httpStatusCode: 400 }), 'Oops'),
		).toBe(false);
		expect(showMessageSpy).not.toHaveBeenCalled();
	});
});
