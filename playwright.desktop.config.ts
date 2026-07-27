import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './test/desktop',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['html', { outputFolder: 'playwright-report/desktop', open: 'never' }]],
  outputDir: 'test-results/desktop',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  }
})
