<script setup lang="ts">
import { computed } from 'vue'
import type { RecoveryActionKind } from '../../../shared/agent-contracts'
import type { ChatActivityEntry } from './useChatTimeline'

const props = defineProps<{ entry: ChatActivityEntry }>()
const emit = defineEmits<{
  action: [kind: RecoveryActionKind]
}>()

const phases = [
  'accepted',
  'ingesting',
  'briefing',
  'planning',
  'inspecting',
  'executing',
  'verifying',
  'completed'
]

const currentPhaseIndex = computed(() => {
  const phase =
    props.entry.terminal?.phase === 'completed'
      ? 'completed'
      : props.entry.phase
  return phases.indexOf(phase ?? '')
})

const drawingChanged = computed(() => {
  const value = props.entry.terminal?.recovery?.drawingChanged
  if (value === true) return 'Yes — committed changes were recorded.'
  if (value === false) return 'No drawing change was recorded.'
  if (value === 'unknown') return 'Unknown — review operation receipts first.'
  const receipts = props.entry.terminal
    ? undefined
    : props.entry.receipt
  return receipts?.status === 'committed'
    ? 'Yes — this operation committed.'
    : receipts
      ? `No committed change (${receipts.status}).`
      : 'No drawing change was reported.'
})

function humanize(value: string): string {
  return value.replaceAll('-', ' ').replaceAll('_', ' ')
}
</script>

<template>
  <section
    class="activity-card"
    :class="[
      entry.activity,
      entry.terminal?.phase === 'failed' ? 'failed' : ''
    ]"
    :data-recovery-card="entry.terminal?.phase === 'failed' || undefined"
    :tabindex="entry.terminal?.phase === 'failed' ? -1 : undefined"
    :aria-label="`${humanize(entry.activity)} activity`"
  >
    <template v-if="entry.activity === 'progress'">
      <header>
        <strong>Turn progress</strong>
        <span>{{ humanize(entry.phase || 'accepted') }}</span>
      </header>
      <ol class="phase-stepper" aria-label="Assistant turn phases">
        <li
          v-for="(phase, index) in phases"
          :key="phase"
          :class="{
            complete: index < currentPhaseIndex,
            current: index === currentPhaseIndex
          }"
          :aria-current="index === currentPhaseIndex ? 'step' : undefined"
        >
          {{ humanize(phase) }}
        </li>
      </ol>
      <p>{{ entry.status }}</p>
    </template>

    <template v-else-if="entry.activity === 'breakdown' && entry.breakdown">
      <header>
        <strong>Instruction breakdown</strong>
        <span>{{ entry.breakdown.riskLevel }} risk</span>
      </header>
      <p><b>Objective:</b> {{ entry.breakdown.objective }}</p>
      <details>
        <summary>Plan and required context</summary>
        <dl>
          <dt>Inputs</dt>
          <dd>{{ entry.breakdown.inputs.join('; ') || 'None' }}</dd>
          <dt>Constraints</dt>
          <dd>{{ entry.breakdown.constraints.join('; ') || 'None' }}</dd>
          <dt>Drawing context</dt>
          <dd>
            {{ entry.breakdown.requiredDrawingContext.join('; ') || 'None' }}
          </dd>
          <dt>Tool categories</dt>
          <dd>
            {{ entry.breakdown.plannedToolCategories.join('; ') || 'None' }}
          </dd>
          <dt>Expected output</dt>
          <dd>{{ entry.breakdown.expectedOutput }}</dd>
        </dl>
      </details>
    </template>

    <template v-else-if="entry.activity === 'skills'">
      <header>
        <strong>Active skills</strong>
        <span>{{ entry.skills?.length ?? 0 }} verified manifests</span>
      </header>
      <ul class="skill-list">
        <li
          v-for="skill in entry.skills"
          :key="skill.skillId"
          :class="{ failed: skill.integrity === 'failed' }"
        >
          <span>{{ skill.name }} {{ skill.version }}</span>
          <b>{{ skill.integrity }}</b>
        </li>
      </ul>
    </template>

    <template v-else-if="entry.activity === 'receipt' && entry.receipt">
      <header>
        <strong>Operation receipt</strong>
        <span>{{ humanize(entry.receipt.status) }}</span>
      </header>
      <p>
        {{ humanize(entry.receipt.toolName) }} ·
        {{ entry.receipt.affectedEntityIds.length }} affected
        {{ entry.receipt.affectedEntityIds.length === 1 ? 'entity' : 'entities' }}
      </p>
      <details>
        <summary>Technical details</summary>
        <dl>
          <dt>Operation ID</dt>
          <dd>{{ entry.receipt.operationId }}</dd>
          <dt>Revision before</dt>
          <dd>{{ JSON.stringify(entry.receipt.revisionBefore) }}</dd>
          <dt>Revision after</dt>
          <dd>
            {{
              entry.receipt.revisionAfter
                ? JSON.stringify(entry.receipt.revisionAfter)
                : 'No committed revision'
            }}
          </dd>
        </dl>
      </details>
    </template>

    <template v-else-if="entry.activity === 'terminal' && entry.terminal">
      <header>
        <strong>
          {{
            entry.terminal.phase === 'failed'
              ? 'Assistant needs attention'
              : 'Turn verification'
          }}
        </strong>
        <span>{{ humanize(entry.terminal.outcome) }}</span>
      </header>

      <div v-if="entry.terminal.error" class="failure-grid">
        <b>What happened</b>
        <p>{{ entry.terminal.error.userMessage }}</p>
        <b>What EnvCAD already tried</b>
        <p>
          {{
            entry.terminal.recovery?.attempts.length
              ? entry.terminal.recovery.attempts
                  .map((attempt) => humanize(attempt.strategy))
                  .join(', ')
              : 'The turn was stopped safely and its journal was preserved.'
          }}
        </p>
        <b>Whether the drawing changed</b>
        <p>{{ drawingChanged }}</p>
        <b>What you can do next</b>
        <div class="recovery-actions">
          <button
            v-for="action in entry.terminal.error.recoveryActions"
            :key="action.id"
            type="button"
            :disabled="!action.enabled"
            @click="emit('action', action.kind)"
          >
            {{ action.label }}
          </button>
        </div>
      </div>

      <div v-if="entry.terminal.verification" class="verification">
        <p>
          <b>Mode:</b>
          {{ humanize(entry.terminal.verification.mode) }}
        </p>
        <ul>
          <li
            v-for="check in entry.terminal.verification.databaseChecks"
            :key="check"
          >
            {{ check }}
          </li>
        </ul>
        <p v-if="entry.terminal.verification.visualEvidenceIds.length">
          <b>Visual evidence:</b>
          {{ entry.terminal.verification.visualEvidenceIds.join(', ') }}
        </p>
        <p
          v-for="warning in entry.terminal.verification.warnings"
          :key="warning"
          class="warning"
        >
          {{ warning }}
        </p>
      </div>
    </template>
  </section>
</template>

<style scoped>
.activity-card {
  width: min(100%, 420px);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-panel);
  color: var(--text-primary);
  padding: 10px;
  font-size: 12px;
  line-height: 1.45;
}

.activity-card.failed {
  border-color: var(--error-border);
  background: var(--error-bg);
}

header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

header span,
summary {
  color: var(--text-secondary);
}

p {
  margin: 7px 0 0;
}

.phase-stepper {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 8px 0 0;
  margin: 0;
  list-style: none;
}

.phase-stepper li {
  border: 1px solid var(--border-color);
  border-radius: 999px;
  padding: 2px 6px;
  color: var(--text-muted);
}

.phase-stepper li.complete::before {
  content: 'Done: ';
}

.phase-stepper li.current {
  border-color: var(--accent);
  color: var(--text-primary);
  font-weight: 600;
}

.skill-list,
.verification ul {
  margin: 8px 0 0;
  padding-left: 18px;
}

.skill-list li {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}

.skill-list li.failed,
.warning {
  color: var(--error-text);
}

details {
  margin-top: 8px;
}

summary,
button {
  cursor: pointer;
}

dl,
.failure-grid {
  display: grid;
  grid-template-columns: minmax(110px, 0.45fr) minmax(0, 1fr);
  gap: 5px 8px;
  margin: 8px 0 0;
}

dt,
.failure-grid > b {
  color: var(--text-secondary);
}

dd,
.failure-grid > p {
  margin: 0;
  overflow-wrap: anywhere;
}

.recovery-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

button {
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--bg-button);
  color: var(--text-primary);
  padding: 5px 8px;
  font: inherit;
}

button:focus-visible,
summary:focus-visible,
.activity-card:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
