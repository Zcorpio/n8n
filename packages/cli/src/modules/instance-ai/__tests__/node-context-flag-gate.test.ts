import { AI_ASSISTANT_AT_MENTIONS_FLAG, CANVAS_NODE_CONTEXT_FLAG } from '@n8n/api-types';
import type { User } from '@n8n/db';
import type { Mocked } from 'vitest';
import { mock } from 'vitest-mock-extended';

import type { PostHogClient } from '@/posthog';

import { NodeContextFlagGate } from '../node-context-flag-gate';

describe('NodeContextFlagGate', () => {
	let postHogClient: Mocked<PostHogClient>;
	let gate: NodeContextFlagGate;
	const user = mock<User>({ id: 'user-1' });

	beforeEach(() => {
		postHogClient = mock<PostHogClient>();
		gate = new NodeContextFlagGate(postHogClient);
	});

	it('resolves true when the canvas node-context flag is on', async () => {
		postHogClient.getFeatureFlags.mockResolvedValue({ [CANVAS_NODE_CONTEXT_FLAG]: true });

		expect(await gate.isEnabled(user)).toBe(true);
	});

	it('resolves true when the Assistant mentions flag is on', async () => {
		postHogClient.getFeatureFlags.mockResolvedValue({ [AI_ASSISTANT_AT_MENTIONS_FLAG]: true });

		expect(await gate.isEnabled(user)).toBe(true);
	});

	it('resolves false when the flag is absent', async () => {
		postHogClient.getFeatureFlags.mockResolvedValue({});

		expect(await gate.isEnabled(user)).toBe(false);
	});

	it('resolves false when both flags are explicitly off', async () => {
		postHogClient.getFeatureFlags.mockResolvedValue({
			[CANVAS_NODE_CONTEXT_FLAG]: false,
			[AI_ASSISTANT_AT_MENTIONS_FLAG]: false,
		});

		expect(await gate.isEnabled(user)).toBe(false);
	});

	it('resolves false (fail-closed) when getFeatureFlags rejects', async () => {
		postHogClient.getFeatureFlags.mockRejectedValue(new Error('PostHog unreachable'));

		await expect(gate.isEnabled(user)).resolves.toBe(false);
	});
});
