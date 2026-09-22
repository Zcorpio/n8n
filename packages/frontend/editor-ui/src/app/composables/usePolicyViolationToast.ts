import { h } from 'vue';
import type { PolicyViolation } from '@n8n/api-types';
import { useToast } from '@n8n/composables/useToast';
import {
	getPolicyViolations,
	PolicyViolationList,
} from '@n8n/frontend-module-type-availability-policies';
import { canvasEventBus } from '@/features/workflows/canvas/canvas.eventBus';
import { useNodeTypesStore } from '@/app/stores/nodeTypes.store';
import { useCredentialsStore } from '@/features/credentials/credentials.store';
import { useWorkflowsStore } from '@/app/stores/workflows.store';
import {
	createWorkflowDocumentId,
	useWorkflowDocumentStore,
	type WorkflowDocumentId,
} from '@/app/stores/workflowDocument.store';

const NODE_TYPE_SUBJECT = 'nodeType';
const CREDENTIAL_TYPE_SUBJECT = 'credentialType';

export function usePolicyViolationToast() {
	const toast = useToast();
	const workflowsStore = useWorkflowsStore();
	const nodeTypesStore = useNodeTypesStore();
	const credentialsStore = useCredentialsStore();

	function displayNameOf({ subject, subjectType }: PolicyViolation): string | undefined {
		if (subject === undefined) return undefined;

		if (subjectType === NODE_TYPE_SUBJECT) {
			return nodeTypesStore.getNodeType(subject)?.displayName;
		}

		if (subjectType === CREDENTIAL_TYPE_SUBJECT) {
			return credentialsStore.getCredentialTypeByName(subject)?.displayName;
		}

		return undefined;
	}

	function nodeIdsOfType(nodeType: string, documentId: WorkflowDocumentId): string[] {
		const documentStore = useWorkflowDocumentStore(documentId);

		return documentStore.allNodes.filter((node) => node.type === nodeType).map((node) => node.id);
	}

	/** Returns false when the error carries no violations, so the caller keeps its own handling. */
	function showPolicyViolationToast(
		error: unknown,
		title: string,
		documentId: WorkflowDocumentId = createWorkflowDocumentId(workflowsStore.workflowId),
	): boolean {
		const violations = getPolicyViolations(error);
		if (!violations) return false;

		// A subject is a type name, so one violation can point at several nodes.
		const nodeIdsBySubject = new Map<string, string[]>();
		const subjectLabels: Record<string, string> = {};

		for (const violation of violations) {
			const { subject, subjectType } = violation;
			if (subject === undefined) continue;

			const displayName = displayNameOf(violation);
			if (displayName !== undefined) subjectLabels[subject] = displayName;

			if (subjectType !== NODE_TYPE_SUBJECT) continue;

			const ids = nodeIdsOfType(subject, documentId);
			if (ids.length > 0) nodeIdsBySubject.set(subject, ids);
		}

		toast.showMessage({
			title,
			type: 'error',
			duration: 0,
			message: h(PolicyViolationList, {
				violations,
				jumpableSubjects: [...nodeIdsBySubject.keys()],
				subjectLabels,
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
