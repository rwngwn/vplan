import { existsSync } from 'node:fs'
import { defineConfig, devices } from '@playwright/test'

const nixChromiumPath = '/home/hermes/.nix-profile/bin/chromium'
const chromiumExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  || (existsSync(nixChromiumPath) ? nixChromiumPath : undefined)
const e2ePort = 3100
const baseURL = `http://127.0.0.1:${e2ePort}`

export default defineConfig({
  testDir: './tests/e2e',
  retries: process.env.CI ? 2 : 1,
  use: {
    baseURL,
    trace: 'on-first-retry',
    launchOptions: chromiumExecutablePath ? { executablePath: chromiumExecutablePath } : undefined,
  },
  webServer: {
    command: `npm run dev -- --port ${e2ePort}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
