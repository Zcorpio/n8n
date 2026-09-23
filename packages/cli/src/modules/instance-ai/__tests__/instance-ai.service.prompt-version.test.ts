import { resolveOperatorPromptVersion } from '../instance-ai.service';

describe('resolveOperatorPromptVersion', () => {
	it.each(['', '   '])('treats %p as no pin', (configured) => {
		// An empty string must not reach `resolvePromptProfile`: it would be
		// reported as a fallback from an unknown version instead of a clean default.
		expect(resolveOperatorPromptVersion(configured)).toBeUndefined();
	});

	it.each(['default@1', 'progressive@1', 'concise@1'])(
		'accepts published version %s',
		(version) => {
			expect(resolveOperatorPromptVersion(version)).toBe(version);
		},
	);

	it('trims surrounding whitespace', () => {
		expect(resolveOperatorPromptVersion('  concise@1\n')).toBe('concise@1');
	});

	it('throws on an unpublished version so a typo fails at startup', () => {
		expect(() => resolveOperatorPromptVersion('concise@2')).toThrow(
			'Unknown Instance AI prompt version',
		);
	});
});
