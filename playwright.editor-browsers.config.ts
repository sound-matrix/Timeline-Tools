import { defineConfig } from "@playwright/test";
import desk from "./playwright.desk.config";
const launch = desk.use?.launchOptions;
export default defineConfig({
  ...desk,
  testMatch: ["editor.spec.ts", "editor-daw.spec.ts"],
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        launchOptions: {
          ...launch,
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
        },
      },
    },
    {
      name: "firefox",
      use: {
        browserName: "firefox",
        launchOptions: {
          ...launch,
          executablePath: process.env.PLAYWRIGHT_FIREFOX_EXECUTABLE_PATH,
        },
      },
    },
    {
      name: "webkit",
      use: {
        browserName: "webkit",
        launchOptions: {
          ...launch,
          executablePath: process.env.PLAYWRIGHT_WEBKIT_EXECUTABLE_PATH,
        },
      },
    },
  ],
});
