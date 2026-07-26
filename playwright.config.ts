import { defineConfig, devices } from '@playwright/test'

const anthropicVariables = Object.keys(process.env).filter((name) =>
  name.startsWith('ANTHROPIC_')
)
if (anthropicVariables.length > 0) {
  throw new Error(
    `E2E tests refuse Anthropic credentials: unset ${anthropicVariables.join(', ')}`
  )
}

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  outputDir: 'test-results',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    acceptDownloads: true
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ],
  webServer: [
    {
      command:
        'vite build --mode e2e && vite preview --host 127.0.0.1 --port 4173',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe'
    },
    {
      command: 'tsx test/fakeSidecar.ts',
      url: 'http://127.0.0.1:8788/health',
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: 'pipe',
      stderr: 'pipe'
    }
  ]
})
