import { expect, test } from '@playwright/test'

const CONTROL_URL = 'http://127.0.0.1:8788'

test('keeps no-document conversation available and shows mandatory skill integrity', async ({
  page,
  request
}) => {
  await request.post(`${CONTROL_URL}/start`)
  await request.post(`${CONTROL_URL}/reset-stats`)
  await page.goto('/')

  await expect(page.getByText('Conversation is available.')).toBeVisible()
  await expect(page.getByLabel('Assistant message')).toBeEditable()
  await page
    .getByLabel('Assistant message')
    .fill('Hello, conversation only. Explain the Assistant Workbench.')
  await page.getByRole('button', { name: 'Send', exact: true }).click()

  const skills = page.locator('.activity-card.skills')
  await expect(skills).toContainText('CAD Core')
  await expect(skills).toContainText('DXF Core')
  await expect(skills.locator('.skill-list li')).toHaveCount(2)
  await expect(skills.locator('.skill-list b')).toHaveText([
    'verified',
    'verified'
  ])
  await expect(page.locator('.activity-card.terminal')).toContainText(
    'not applicable'
  )
})
