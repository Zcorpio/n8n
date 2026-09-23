import { createTestingPinia } from '@pinia/testing';
import { setActivePinia } from 'pinia';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createComponentRenderer } from '@/__tests__/render';

import AssistantAtMentionPicker from './AssistantAtMentionPicker.vue';
import type { AssistantMentionSelection } from './assistantAtMentions.types';

const renderComponent = createComponentRenderer(AssistantAtMentionPicker);

describe('AssistantAtMentionPicker', () => {
	beforeEach(() => {
		setActivePinia(createTestingPinia({ stubActions: false }));
	});

	it('renders artifact browse roots and emits a workflow selection', async () => {
		const input = document.createElement('textarea');
		const reference = document.createElement('div');
		document.body.append(input, reference);
		const { findByText, emitted } = renderComponent({
			props: {
				modelValue: true,
				query: '',
				projectId: undefined,
				artifacts: [{ id: 'w1', name: 'Orders' }],
				inputElement: input,
				reference,
			},
		});

		await userEvent.click(await findByText('Orders'));

		const selection = (emitted().select as unknown[][] | undefined)?.[0]?.[0] as
			| AssistantMentionSelection
			| undefined;
		expect(selection).toMatchObject({
			item: { kind: 'workflow', workflowId: 'w1', label: 'Orders' },
			attachment: { type: 'workflow', id: 'w1', name: 'Orders' },
			telemetry: { mode: 'browse', resultPosition: 1, queryLength: 0 },
		});
	});

	it('reports privacy-safe search interaction metadata', async () => {
		const input = document.createElement('textarea');
		const reference = document.createElement('div');
		document.body.append(input, reference);
		const pinia = createTestingPinia({ stubActions: true });
		setActivePinia(pinia);
		const { useWorkflowsListStore } = await import('@/app/stores/workflowsList.store');
		vi.mocked(useWorkflowsListStore().searchWorkflows).mockResolvedValue([
			{ id: 'w1', name: 'Orders' },
		] as never);
		const { findByText, emitted } = renderComponent({
			props: {
				modelValue: true,
				query: 'ord',
				projectId: 'project-1',
				inputElement: input,
				reference,
			},
		});

		await userEvent.click(await findByText('Orders'));

		const selection = (emitted().select as unknown[][] | undefined)?.[0]?.[0] as
			| AssistantMentionSelection
			| undefined;
		expect(selection?.telemetry).toEqual({
			mode: 'search',
			resultPosition: 1,
			queryLength: 3,
		});
		expect(selection?.item).not.toHaveProperty('query');
	});

	it('emits open state from the mention button', async () => {
		const { getByTestId, emitted } = renderComponent({
			props: { modelValue: false, query: '' },
		});

		await userEvent.click(getByTestId('instance-ai-mention-button'));
		expect(emitted()['update:modelValue']?.[0]).toEqual([true]);
	});

	it('shows the empty recent-workflow state after browse completes', async () => {
		const { findByText } = renderComponent({
			props: { modelValue: true, query: '', projectId: undefined },
		});

		expect(await findByText('No recent workflows')).toBeVisible();
	});

	it('shows a retry action when workflow browse fails', async () => {
		setActivePinia(createTestingPinia());
		const { useRecentWorkflowsStore } = await import('@/app/stores/recentWorkflows.store');
		const recentWorkflowsStore = useRecentWorkflowsStore();
		vi.mocked(recentWorkflowsStore.resolveRecentWorkflows).mockRejectedValue(
			new Error('Request failed'),
		);
		const { findByText, getByRole } = renderComponent({
			props: {
				modelValue: true,
				query: '',
				projectId: 'project-1',
				artifacts: [{ id: 'w1', name: 'Orders' }],
			},
		});

		expect(await findByText('Orders')).toBeVisible();
		expect(await findByText("Workflows couldn't load. Try again.")).toBeVisible();
		await userEvent.click(getByRole('menuitem', { name: 'Retry' }));
		expect(recentWorkflowsStore.resolveRecentWorkflows).toHaveBeenCalledTimes(2);
	});
});
