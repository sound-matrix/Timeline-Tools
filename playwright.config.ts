import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
if (existsSync(".env.local")) process.loadEnvFile(".env.local");
if (existsSync(".env.test.local")) process.loadEnvFile(".env.test.local");
export default defineConfig({
  testDir: "tests/browser",
  timeout: 90000,
  workers: 1,
  use: {
    baseURL: "http://localhost:3100",
    headless: true,
    launchOptions: {
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
      proxy: process.env.HTTPS_PROXY
        ? { server: process.env.HTTPS_PROXY, bypass: "127.0.0.1,localhost" }
        : undefined,
    },
  },
  webServer: {
    command: "npm run start -- --hostname 127.0.0.1 --port 3100",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: false,
    timeout: 60000,
  },
});
