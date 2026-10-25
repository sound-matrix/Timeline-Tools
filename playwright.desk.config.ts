import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

process.env.DESK_FIXTURE = "1";

export default defineConfig({
  ...base,
  testMatch: [
    "desk.spec.ts",
    "subtitles.spec.ts",
    "audio-studio.spec.ts",
    "atelier.spec.ts",
    "podcast.spec.ts",
    "editor.spec.ts",
    "editor-daw.spec.ts",
  ],
  webServer: [
    {
      command: "node tests/fixtures/studio-api.mjs",
      url: "http://127.0.0.1:54331/health",
      reuseExistingServer: false,
    },
    {
      command: "npm run start -- --hostname 127.0.0.1 --port 3100",
      url: "http://127.0.0.1:3100",
      reuseExistingServer: false,
      env: {
        NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54331",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "desk-test-key",
      },
    },
  ],
});
