import { describe, expect, it } from 'vitest'
import {
  ContextBudgetExceededError,
  ContextBudgetManager
} from '../application/input/ContextBudgetManager'

function manager(capacityBytes = 90): ContextBudgetManager {
  return new ContextBudgetManager({
    staticContextBytes: 10,
    contextWindowTokens: capacityBytes + 11,
    outputReserveTokens: 1,
    bytesPerToken: 1,
    imageReserveBytes: 8
  })
}

describe('ContextBudgetManager', () => {
  it('accounts for static context, prompts, tool results, and image reserves', () => {
    const budget = manager()
    budget.beginTurn()
    budget.registerPrompt('prompt')

    expect(
      budget.reserveToolResult({ value: 'result' }, { hasImage: true })
    ).toMatchObject({ allowed: true })
    expect(budget.snapshot()).toMatchObject({
      capacityBytes: 100,
      promptBytes: 6,
      toolResultBytes: Buffer.byteLength(
        JSON.stringify({ value: 'result' }),
        'utf8'
      ) + 8
    })
  })

  it('rejects a prompt before provider execution when capacity is exhausted', () => {
    const budget = manager(20)
    budget.beginTurn()

    expect(() => budget.registerPrompt('x'.repeat(21))).toThrow(
      ContextBudgetExceededError
    )
    expect(budget.snapshot()).toMatchObject({
      usedBytes: 10,
      promptBytes: 0
    })
  })

  it('resets all per-turn accounting without retaining failed reservations', () => {
    const budget = manager(30)
    budget.beginTurn()
    budget.registerPrompt('first')
    expect(budget.reserveMaximumToolResult(100).allowed).toBe(false)
    budget.endTurn()
    budget.beginTurn()

    expect(budget.snapshot()).toEqual({
      capacityBytes: 40,
      usedBytes: 10,
      remainingBytes: 30,
      promptBytes: 0,
      toolResultBytes: 0
    })
  })
})
