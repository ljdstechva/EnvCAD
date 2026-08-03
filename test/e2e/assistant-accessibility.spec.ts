import { expect, test } from '@playwright/test'

const CONTROL_URL = 'http://127.0.0.1:8788'

test('supports keyboard resizing, queued composing, and announced progress', async ({
  page,
  request
}) => {
  await request.post(`${CONTROL_URL}/start`)
  await request.post(`${CONTROL_URL}/reset-stats`)
  await request.post(`${CONTROL_URL}/delay?ms=1000`)
  await page.goto('/')

  const workbench = page.getByRole('complementary', {
    name: 'Assistant Workbench'
  })
  const initialBox = await workbench.boundingBox()
  expect(initialBox?.width).toBeGreaterThanOrEqual(380)
  expect(initialBox?.width).toBeLessThanOrEqual(420)

  const separator = page.getByRole('separator', {
    name: 'Resize Assistant Workbench'
  })
  await separator.focus()
  await separator.press('ArrowLeft')
  await expect(separator).toHaveAttribute('aria-valuenow', '416')
  await separator.press('End')
  await expect(separator).toHaveAttribute('aria-valuenow', '560')
  await separator.press('Home')
  await expect(separator).toHaveAttribute('aria-valuenow', '340')

  const composer = page.getByLabel('Assistant message')
  await composer.fill('Hello, conversation only. First turn.')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('.activity-card.progress')).toBeVisible()
  await expect(composer).toBeEditable()

  await composer.fill('Hello, conversation only. Queued follow-up.')
  await page.getByRole('button', { name: 'Queue follow-up' }).click()
  await expect(
    page.getByRole('region', { name: 'Queued assistant follow-ups' })
  ).toContainText('Queued follow-up')
  await expect(page.locator('[aria-live="assertive"]')).not.toBeEmpty()
  await expect(page.locator('.activity-card.terminal').first()).toBeVisible()
})
