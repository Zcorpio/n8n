import { AI_ASSISTANT_AT_MENTIONS_FLAG, CANVAS_NODE_CONTEXT_FLAG } from '@n8n/api-types';
import type { User } from '@n8n/db';
import { Service } from '@n8n/di';

import { PostHogClient } from '@/posthog';

/**
 * Per-user rollout gate for node context in the n8n Assistant.
 *
 * PostHog owns both the canvas node-context and Assistant mentions cohorts.
 * Either cohort can send node context, but only the canvas flag controls canvas
 * entry points. Fails closed on any PostHog error.
 */
@Service()
export class NodeContextFlagGate {
	constructor(private readonly postHogClient: PostHogClient) {}

	async isEnabled(user: User): Promise<boolean> {
		try {
			const flags = await this.postHogClient.getFeatureFlags(user);
			return (
				flags?.[CANVAS_NODE_CONTEXT_FLAG] === true ||
				flags?.[AI_ASSISTANT_AT_MENTIONS_FLAG] === true
			);
		} catch {
			return false;
		}
	}
}
