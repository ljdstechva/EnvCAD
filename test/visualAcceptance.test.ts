import { describe, expect, it } from 'vitest'
import {
  compareVisualAnswer,
  HIDDEN_MARKER_PROMPT,
  parseVisualModelAnswer
} from '../scripts/visualAcceptance'
import { visualFixtureExpectation } from '../scripts/visualFixtures'

describe('live visual acceptance contracts', () => {
  it('keeps the undisclosed arrangements out of the provider prompt', () => {
    expect(HIDDEN_MARKER_PROMPT).not.toContain('red circle')
    expect(HIDDEN_MARKER_PROMPT).not.toContain('green square')
    expect(HIDDEN_MARKER_PROMPT).not.toContain('cyan triangle')
    expect(HIDDEN_MARKER_PROMPT).not.toContain('magenta circle')
  })

  it('parses strict structured visual output and compares exact markers', () => {
    const expected = visualFixtureExpectation('a')
    const response = JSON.stringify({
      blank: false,
      orientation: 'landscape',
      markers: expected.markers,
      borderVisible: true,
      titleBlockVisible: false,
      clipping: false,
      overlap: false
    })
    const answer = parseVisualModelAnswer(`\`\`\`json\n${response}\n\`\`\``)
    expect(compareVisualAnswer(answer, expected)).toEqual([])
  })

  it('reports a changed marker arrangement as a mismatch', () => {
    const first = visualFixtureExpectation('a')
    const second = visualFixtureExpectation('b')
    const issues = compareVisualAnswer(
      {
        blank: false,
        orientation: 'landscape',
        markers: first.markers,
        borderVisible: true,
        titleBlockVisible: false,
        clipping: false,
        overlap: false
      },
      second
    )
    expect(issues).toHaveLength(1)
    expect(issues[0]).toContain('markers=')
  })
})
