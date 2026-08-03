import { expect, test } from '@playwright/test'

const CONTROL_URL = 'http://127.0.0.1:8788'

test('restores a durable turn and queued follow-up after renderer reload', async ({
  page,
  request
}) => {
  await request.post(`${CONTROL_URL}/start`)
  await request.post(`${CONTROL_URL}/reset-stats`)
  await request.post(`${CONTROL_URL}/delay?ms=1500`)
  await page.goto('/')

  const composer = page.getByLabel('Assistant message')
  await composer.fill('Hello, conversation only. Preserve this active turn.')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('.activity-card.progress')).toContainText(
    'planning'
  )

  await composer.fill('Hello, conversation only. Preserve this follow-up too.')
  await page.getByRole('button', { name: 'Queue follow-up' }).click()
  await expect(
    page.getByRole('region', { name: 'Queued assistant follow-ups' })
  ).toBeVisible()

  await page.reload()
  await expect(page.getByLabel('Assistant message')).toBeEditable()
  await expect(page.locator('.bubble.user').first()).toContainText(
    'Preserve this active turn'
  )
  await expect(page.locator('.activity-card.terminal').first()).toBeVisible()
  await expect
    .poll(async () => {
      const stats = await request.get(`${CONTROL_URL}/stats`)
      return (await stats.json()).userMessageCount as number
    })
    .toBe(2)
  await expect(
    page.getByRole('region', { name: 'Queued assistant follow-ups' })
  ).toHaveCount(0)
})
