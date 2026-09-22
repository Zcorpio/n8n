import { h } from 'vue';
import type { PolicyViolation } from '@n8n/api-types';
import { useToast } from '@n8n/composables/useToast';
import {
	getPolicyViolations,
	PolicyViolationList,
} from '@n8n/frontend-module-type-availability-policies';
import { canvasEventBus } from '@/features/workflows/canvas/canvas.eventBus';
import { useWorkflowsStore } from '@/app/stores/workflows.store';
import {
	createWorkflowDocumentId,
	useWorkflowDocumentStore,
} from '@/app/stores/workflowDocument.store';

const NODE_TYPE_SUBJECT = 'nodeType';

export function usePolicyViolationToast() {
	const toast = useToast();
	const workflowsStore = useWorkflowsStore();

	function nodeIdsOfType(nodeType: string): string[] {
		const documentStore = useWorkflowDocumentStore(
			createWorkflowDocumentId(workflowsStore.workflowId),
		);

		return documentStore.allNodes.filter((node) => node.type === nodeType).map((node) => node.id);
	}

	/**
	 * Renders a refusal as one line for each violation. Returns false when the error carries none,
	 * so the caller keeps its own error handling.
	 */
	function showPolicyViolationToast(error: unknown, title: string): boolean {
		const violations = getPolicyViolations(error);
		if (!violations) return false;

		// A subject is a node type name, so one violation can point at several nodes.
		const nodeIdsBySubject = new Map<string, string[]>();
		for (const { subject, subjectType } of violations) {
			if (subjectType !== NODE_TYPE_SUBJECT || subject === undefined) continue;

			const ids = nodeIdsOfType(subject);
			if (ids.length > 0) nodeIdsBySubject.set(subject, ids);
		}

		toast.showMessage({
			title,
			type: 'error',
			duration: 0,
			message: h(PolicyViolationList, {
				violations,
				jumpableSubjects: [...nodeIdsBySubject.keys()],
				onJump: (violation: PolicyViolation) => {
					const ids = violation.subject && nodeIdsBySubject.get(violation.subject);
					if (ids) canvasEventBus.emit('nodes:select', { ids, panIntoView: true });
				},
			}),
		});

		return true;
	}

	return { showPolicyViolationToast };
}
