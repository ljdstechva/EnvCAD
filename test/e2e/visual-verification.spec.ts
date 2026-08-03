import { expect, test } from '@playwright/test'
import path from 'node:path'

const CONTROL_URL = 'http://127.0.0.1:8788'
const FIXTURE = path.join(process.cwd(), 'test', 'fixtures', 'sample-site.dxf')

test('binds a visual verification result to concrete image evidence', async ({
  page,
  request
}) => {
  await request.post(`${CONTROL_URL}/start`)
  await request.post(`${CONTROL_URL}/reset-stats`)
  await request.post(`${CONTROL_URL}/visual-result?mode=success`)
  await page.goto('/')
  await page.locator('input[accept=".dxf,.dwg"]').setInputFiles(FIXTURE)
  await expect(page.getByRole('button', { name: 'Save DXF' })).toBeEnabled()

  await page.getByLabel('Assistant message').fill(
    'Inspect the current Sheet Preview. State whether it is blank, clipped, unreadable, low-contrast, or overlapping, and describe only what you can actually see.'
  )
  await page.getByRole('button', { name: 'Send', exact: true }).click()

  const terminal = page.locator('.activity-card.terminal')
  await expect(terminal).toContainText('database and visual')
  await expect(terminal).toContainText('Visual evidence:')
  const evidenceText = await terminal.innerText()
  expect(evidenceText).toMatch(/evidence-[a-z0-9-]+/i)
})
