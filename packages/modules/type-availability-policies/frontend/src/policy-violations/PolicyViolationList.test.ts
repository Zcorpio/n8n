import type { PolicyViolation } from '@n8n/api-types';
import { createComponentRenderer } from '@n8n/frontend-test-utils';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import PolicyViolationList from './PolicyViolationList.vue';

const SLACK_NODE_TYPE = 'n8n-nodes-base.slack';
const GMAIL_CREDENTIAL_TYPE = 'gmailOAuth2';

const slackNodeType: PolicyViolation = {
	kind: 'node-type-unavailable',
	checkId: 'node-type-availability',
	message: `Node type "${SLACK_NODE_TYPE}" is blocked by an instance policy`,
	subject: SLACK_NODE_TYPE,
	subjectType: 'nodeType',
	scope: 'instance',
};

const gmailCredentialType: PolicyViolation = {
	kind: 'node-type-unavailable',
	checkId: 'node-type-availability',
	message: `Credential type "${GMAIL_CREDENTIAL_TYPE}" is blocked in this project`,
	subject: GMAIL_CREDENTIAL_TYPE,
	subjectType: 'credentialType',
	scope: 'project',
};

const renderComponent = createComponentRenderer(PolicyViolationList, {
	props: { violations: [slackNodeType], jumpableSubjects: [] },
});

describe('PolicyViolationList', () => {
	it('renders one line for each violation with its type, reason and scope', () => {
		const { getAllByTestId } = renderComponent({
			props: { violations: [slackNodeType, gmailCredentialType] },
		});

		const lines = getAllByTestId('policy-violation');

		expect(lines).toHaveLength(2);
		expect(lines[0]).toHaveTextContent("Node type 'n8n-nodes-base.slack': not available");
		expect(lines[0]).toHaveTextContent('Restricted on this instance');
		expect(lines[1]).toHaveTextContent(`Credential type '${GMAIL_CREDENTIAL_TYPE}': not available`);
		expect(lines[1]).toHaveTextContent('Restricted in this project');
	});

	it('renders an unknown kind and scope as their raw values', () => {
		const { getByTestId } = renderComponent({
			props: {
				violations: [{ ...slackNodeType, kind: 'node-type-deprecated', scope: 'team' }],
			},
		});

		expect(getByTestId('policy-violation')).toHaveTextContent(
			"Node type 'n8n-nodes-base.slack': node-type-deprecated",
		);
		expect(getByTestId('policy-violation')).toHaveTextContent('team');
	});

	it('renders the display name the host resolved instead of the raw subject', () => {
		const { getByTestId } = renderComponent({
			props: {
				violations: [slackNodeType],
				subjectLabels: { [SLACK_NODE_TYPE]: 'Slack' },
			},
		});

		expect(getByTestId('policy-violation')).toHaveTextContent("Node type 'Slack': not available");
		expect(getByTestId('policy-violation')).not.toHaveTextContent(SLACK_NODE_TYPE);
	});

	it('offers no jump for a credential type, even when the host lists its subject', () => {
		const { queryByTestId } = renderComponent({
			props: {
				violations: [gmailCredentialType],
				jumpableSubjects: [GMAIL_CREDENTIAL_TYPE],
			},
		});

		expect(queryByTestId('policy-violation-jump')).not.toBeInTheDocument();
	});

	it('renders the message when the violation names no subject', () => {
		const { getByTestId } = renderComponent({
			props: {
				violations: [
					{
						kind: 'workflow-start-denied',
						checkId: 'workflow-start',
						message: 'This project cannot start workflows',
					},
				],
			},
		});

		expect(getByTestId('policy-violation')).toHaveTextContent(
			'This project cannot start workflows',
		);
	});

	it('offers a jump only for a jumpable subject and emits that violation', async () => {
		const { getAllByTestId, getByTestId, emitted } = renderComponent({
			props: {
				violations: [slackNodeType, gmailCredentialType],
				jumpableSubjects: [SLACK_NODE_TYPE],
			},
		});

		expect(getAllByTestId('policy-violation-jump')).toHaveLength(1);

		await userEvent.click(getByTestId('policy-violation-jump'));

		expect(emitted().jump).toEqual([[slackNodeType]]);
	});
});
