<script setup lang="ts">
import type { PolicyViolation } from '@n8n/api-types';
import { N8nButton, N8nText } from '@n8n/design-system';
import { useI18n, type BaseTextKey } from '@n8n/i18n';

const props = withDefaults(
	defineProps<{
		violations: PolicyViolation[];
		/** Subjects the host can show in the open workflow. Only these lines get a jump button. */
		jumpableSubjects: string[];
		/** Display name for each subject the host could resolve, keyed by the raw subject. */
		subjectLabels?: Record<string, string>;
	}>(),
	{ subjectLabels: () => ({}) },
);

const emit = defineEmits<{ jump: [violation: PolicyViolation] }>();

const i18n = useI18n();

// `subjectType`, `kind` and `scope` are open strings, so an unknown value renders as itself.
const SUBJECT_TYPE_LABEL_KEY: Record<string, BaseTextKey | undefined> = {
	nodeType: 'typeAvailabilityPolicies.violations.subjectType.nodeType',
};

const KIND_REASON_KEY: Record<string, BaseTextKey | undefined> = {
	'node-type-unavailable': 'typeAvailabilityPolicies.violations.kind.nodeTypeUnavailable',
};

const SCOPE_LABEL_KEY: Record<string, BaseTextKey | undefined> = {
	instance: 'typeAvailabilityPolicies.restrictedNode.scope.instance',
	project: 'typeAvailabilityPolicies.restrictedNode.scope.project',
};

function headline(violation: PolicyViolation): string {
	const { subject, subjectType, kind, message } = violation;
	const reasonKey = KIND_REASON_KEY[kind];
	if (!subject || !reasonKey) return message;

	const reason = i18n.baseText(reasonKey);
	const labelKey = subjectType ? SUBJECT_TYPE_LABEL_KEY[subjectType] : undefined;
	const subjectTypeLabel = labelKey ? i18n.baseText(labelKey) : subjectType;
	const subjectLabel = props.subjectLabels[subject] ?? subject;

	if (!subjectTypeLabel) {
		return i18n.baseText('typeAvailabilityPolicies.violations.headlineWithoutType', {
			interpolate: { subject: subjectLabel, reason },
		});
	}

	return i18n.baseText('typeAvailabilityPolicies.violations.headline', {
		interpolate: { subjectTypeLabel, subject: subjectLabel, reason },
	});
}

function scopeLabel(violation: PolicyViolation): string | undefined {
	const { scope } = violation;
	if (!scope) return undefined;

	const key = SCOPE_LABEL_KEY[scope];
	return key ? i18n.baseText(key) : scope;
}

function isJumpable({ subject }: PolicyViolation): boolean {
	return subject !== undefined && props.jumpableSubjects.includes(subject);
}
</script>

<template>
	<ul :class="$style.list">
		<li
			v-for="(violation, index) in violations"
			:key="`${violation.checkId}-${violation.subject ?? ''}-${index}`"
			:class="$style.violation"
			data-test-id="policy-violation"
		>
			<N8nText tag="p" size="small" color="text-dark">{{ headline(violation) }}</N8nText>
			<N8nText v-if="scopeLabel(violation)" tag="p" size="small" color="text-light">
				{{ scopeLabel(violation) }}
			</N8nText>
			<N8nButton
				v-if="isJumpable(violation)"
				variant="outline"
				size="small"
				:class="$style.action"
				data-test-id="policy-violation-jump"
				@click="emit('jump', violation)"
			>
				{{ i18n.baseText('typeAvailabilityPolicies.violations.jump') }}
			</N8nButton>
		</li>
	</ul>
</template>

<style lang="scss" module>
.list {
	list-style: none;
	margin: 0;
	padding: 0;
	display: flex;
	flex-direction: column;
	gap: var(--spacing--xs);
}

.violation {
	display: flex;
	flex-direction: column;
	align-items: flex-start;
}

.action {
	margin-top: var(--spacing--3xs);
}
</style>
