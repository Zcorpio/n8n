import { AI_ASSISTANT_AT_MENTIONS_FLAG, CANVAS_NODE_CONTEXT_FLAG } from '@n8n/api-types';
import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useIsNodeContextEnabled } from './useIsNodeContextEnabled';

const flagValues = vi.hoisted(() => new Map<string, boolean>());

vi.mock('@/app/stores/posthog.store', () => ({
	usePostHog: () => ({ isFeatureEnabled: (flag: string) => flagValues.get(flag) === true }),
}));

vi.mock('@/app/composables/useEditorContext', () => ({
	useEditorContext: () => ({ instanceAi: ref(true) }),
}));

describe('useIsNodeContextEnabled', () => {
	beforeEach(() => {
		flagValues.clear();
	});

	it('keeps canvas controls disabled when only Assistant mentions are enabled', () => {
		flagValues.set(AI_ASSISTANT_AT_MENTIONS_FLAG, true);
		flagValues.set(CANVAS_NODE_CONTEXT_FLAG, false);

		expect(useIsNodeContextEnabled().value).toBe(false);
	});

	it('enables canvas controls with the canvas node-context flag', () => {
		flagValues.set(CANVAS_NODE_CONTEXT_FLAG, true);

		expect(useIsNodeContextEnabled().value).toBe(true);
	});
});
