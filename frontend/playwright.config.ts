import { existsSync } from 'node:fs'
import { defineConfig, devices } from '@playwright/test'

const nixChromiumPath = '/home/hermes/.nix-profile/bin/chromium'
const chromiumExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  || (existsSync(nixChromiumPath) ? nixChromiumPath : undefined)
const e2ePort = 3100
const baseURL = `http://127.0.0.1:${e2ePort}`
const isParityGate = process.env.PLAYWRIGHT_PARITY_GATE === '1'
const isReleaseGate = process.env.RELEASE_GATE_CI === '1'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: (isParityGate || isReleaseGate) ? 0 : (process.env.CI ? 2 : 1),
  use: {
    baseURL,
    trace: 'on-first-retry',
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
    permissions: ['clipboard-read', 'clipboard-write'],
    reducedMotion: 'reduce',
    colorScheme: 'light',
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
