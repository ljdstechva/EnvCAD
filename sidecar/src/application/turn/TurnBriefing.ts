import { classifyInstruction } from '../../domain/turn/InstructionBreakdown'
import type { DurableTurnEventSink } from './DurableTurnEventSink'
import { TurnInputUnavailableError } from './ProviderFailurePolicy'
import type { TurnCancellation } from './TurnCancellation'
import type { TurnExecutionContext } from './TurnExecutionContracts'

interface TurnBriefingOptions {
  sink: DurableTurnEventSink
  context: TurnExecutionContext
  cancellation: TurnCancellation
  progress(
    phase: 'ingesting' | 'briefing',
    status: string
  ): Promise<void>
}

export class TurnBriefing {
  constructor(private readonly options: TurnBriefingOptions) {}

  async prepare(turnId: string): Promise<string> {
    await this.options.progress(
      'ingesting',
      'Preparing the instruction and references.'
    )
    const prompt =
      this.options.context.prompt ??
      (await this.options.cancellation.race(
        this.options.context.resolvePrompt?.() ?? Promise.resolve(undefined)
      ))
    if (!prompt) throw new TurnInputUnavailableError()
    await this.options.progress(
      'briefing',
      'Breaking down the instruction locally.'
    )
    const classified = classifyInstruction(
      this.options.context.draft.payload,
      this.options.context.classificationText
    )
    await this.options.sink.append(turnId, 'instruction-breakdown', {
      type: 'instruction_breakdown',
      turnId,
      breakdown: classified.breakdown
    })
    if (this.options.context.performPrePlanningInspection) {
      await this.options.cancellation.race(
        this.options.context.performPrePlanningInspection()
      )
    }
    return prompt
  }
}
