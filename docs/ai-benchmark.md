# EnvCAD v0.2.1 AI benchmark

## Release result

The installed Windows application completed the representative live matrix on
2026-07-28 using Claude Code 2.1.220 with the existing Claude subscription login
and Codex CLI 0.145.0 with the existing ChatGPT login. The benchmark made 16
turns, including four excluded warm-up/smoke turns and twelve scored task turns.
Four earlier provider-integration probes brought the authorized total to exactly
20 turns.

The benchmark used only a generated empty metre-unit drawing. No client drawing,
credential, hidden reasoning, or authentication output was recorded. Raw
transcripts, DXFs, and screenshots remain in the ignored local
`output/desktop/ai-benchmark/` directory.

## Live capability catalog

The catalog below came from the installed provider runtimes during the final
zero-turn report refresh. **Default** is always available; the listed effort
values are the additional values advertised for that model.

| Provider | Invocation | Resolved model | Provider default | Advertised efforts |
| --- | --- | --- | --- | --- |
| Claude Code | `default` | `claude-opus-5[1m]` | model; `high` effort | `low`, `medium`, `high`, `xhigh`, `max` |
| Claude Code | `opus[1m]` | `claude-opus-5[1m]` | `high` effort | `low`, `medium`, `high`, `xhigh`, `max` |
| Claude Code | `claude-fable-5[1m]` | `claude-fable-5` | `high` effort | `low`, `medium`, `high`, `xhigh`, `max` |
| Claude Code | `sonnet` | `claude-sonnet-5` | `high` effort | `low`, `medium`, `high`, `xhigh`, `max` |
| Claude Code | `haiku` | `claude-haiku-4-5-20251001` | none reported | Default only |
| OpenAI Codex | `gpt-5.6-sol` | — | model; `low` effort | `low`, `medium`, `high`, `xhigh`, `max` |
| OpenAI Codex | `gpt-5.6-terra` | — | `medium` effort | `low`, `medium`, `high`, `xhigh`, `max` |
| OpenAI Codex | `gpt-5.6-luna` | — | `medium` effort | `low`, `medium`, `high`, `xhigh`, `max` |
| OpenAI Codex | `gpt-5.5` | — | `medium` effort | `low`, `medium`, `high`, `xhigh` |
| OpenAI Codex | `gpt-5.4` | — | `medium` effort | `low`, `medium`, `high`, `xhigh` |
| OpenAI Codex | `gpt-5.4-mini` | — | `medium` effort | `low`, `medium`, `high`, `xhigh` |
| OpenAI Codex | `gpt-5.3-codex-spark` | — | `high` effort | `low`, `medium`, `high`, `xhigh` |

Because 12 models were visible, the excluded smoke checks used the balanced
representatives (`sonnet` and `gpt-5.6-terra`) in addition to one excluded
provider-default warm-up per provider.

## Scored configurations

Observed duration is Task A plus Task B wall time. It is comparative and includes
provider/network latency. No completed configuration exceeded the 120-second
slow threshold.

| Configuration | Effort | Score | Observed total | Result |
| --- | --- | ---: | ---: | --- |
| Claude Code `default` | Default | 100/100 | 36.31 s | Correct |
| Claude Code `haiku` | Default | 75/100 | 28.25 s | Dimension omitted the required layer argument; round-trip IDs did not all match the report |
| Claude Code `opus[1m]` | `max` | 100/100 | 46.23 s | Correct |
| OpenAI Codex `gpt-5.6-sol` | Default | 100/100 | 42.80 s | Correct |
| OpenAI Codex `gpt-5.3-codex-spark` | `low` | 20/100 | 12.04 s plus failed Task B | Task B used nonexistent layer `current`; the validated tool rejected it and the turn was not retried |
| OpenAI Codex `gpt-5.6-sol` | `max` | 100/100 | 61.83 s | Correct |

The 100-point results contain:

- one closed 20 m by 10 m rectangle with measured area exactly 200 m²;
- one circle centered at (30 m, 10 m) with radius exactly 5 m;
- a radius dimension linked to the actual circle;
- `AI BENCHMARK` text inserted at (30 m, 17 m), height 1 m;
- all four model-space entities on `AI_BENCHMARK`;
- layer true color exactly `0x00a86b`;
- Task A entity count 1 and Task B entity count 4, with the rectangle unchanged;
- AC1018 DXF output, metre units code 6, and identical geometry after reopen;
- zero reported retries, silent tool failures, or security-boundary events.

## Recommendations

- **Claude Code:** `default` model with **Default** effort.
- **OpenAI Codex:** `gpt-5.6-sol` with **Default** effort.

Each recommendation scored 100/100 and is on its provider's measured
quality/latency Pareto frontier. Claude `opus[1m]` at `max` and Codex
`gpt-5.6-sol` at `max` had the same quality at higher latency, so neither is
recommended merely for using a higher effort.

## Evidence and recovery notes

The benchmark checkpoint records every turn before dispatch, so consumed turns
were never repeated.

During the first run, the model completed Claude default Task A, but Playwright
did not surface Electron's main-session download event. Its live screenshot,
five successful canonical tool calls, measured area, entity ID, and timing were
retained. The DXF stage was reconstructed from that exact evidence and
save/reopen-verified without another provider turn.

That recovery exposed an application defect: mlightcad wrote DXF group 420 but
dropped it on import, turning the benchmark layer white after reopen. EnvCAD now
restores true-color values from validated `LAYER` records. Existing successful
provider geometry and live turn evidence were retained; the affected Task B
layer records were reconstructed from their matching Task A files, then opened,
saved, reopened, and visually captured through the corrected installed v0.2.1
ASAR (`BCBC7252D2EC3D992C8DC4DB7A0DAF63694528A92BFFBC8262D4424F8F0C895F`).
The pre-fix artifacts remain beside the recovered raw evidence.

The Codex Spark Task B failure is part of the score, not hidden or retried. Its
checkpoint records turn 14 and the exact browser rejection. The final report
refresh used zero model turns.

Final-build screenshots visually show the green rectangle, circle, and linked
radial dimension for both recommended provider configurations. Database
inspection additionally verifies the text entity, exact coordinates, handles,
layer, units, and save/reopen fingerprints.
