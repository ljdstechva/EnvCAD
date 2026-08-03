import { expect, test } from '@playwright/test'

const CONTROL_URL = 'http://127.0.0.1:8788'

test.beforeEach(async ({ page, request }) => {
  await request.post(`${CONTROL_URL}/start`)
  await request.post(`${CONTROL_URL}/reset-stats`)
  await request.post(`${CONTROL_URL}/scenario?name=ready`)
  await page.goto('/')
  await expect(page.getByLabel('AI provider', { exact: true })).toBeEnabled()
  await expect(page.getByLabel('Assistant message')).toBeEditable()
})

test('streams a large composer instruction into a local reference without rendering its body', async ({
  page,
  request
}) => {
  const beginning = 'BEGIN-LONG-PROMPT-SENTINEL'
  const middle = 'MIDDLE-LONG-PROMPT-SENTINEL'
  const ending = 'END-LONG-PROMPT-SENTINEL'
  const text =
    `Hello, conversation only. ${beginning}\n` +
    `${'a'.repeat(300_000)}\n${middle}\n` +
    `${'b'.repeat(300_000)}\n${ending}`

  await page.getByLabel('Assistant message').fill(text)
  await page.getByRole('button', { name: 'Send', exact: true }).click()

  await expect(page.locator('.activity-card.terminal')).toContainText(
    'Turn verification'
  )
  const renderedUserText = await page.locator('.bubble.user').last().innerText()
  expect(renderedUserText.length).toBeLessThan(5_000)
  expect(renderedUserText).toContain('Large instruction stored locally')
  expect(renderedUserText).toContain(beginning)
  expect(renderedUserText).toContain(ending)

  const stats = await request.get(`${CONTROL_URL}/stats`).then((response) =>
    response.json()
  )
  expect(stats.lastPromptEvidence).toMatchObject({
    hasBeginSentinel: true,
    hasMiddleSentinel: true,
    hasEndSentinel: true
  })
  expect(stats.lastPromptEvidence.utf8Bytes).toBeGreaterThan(512 * 1024)
})
