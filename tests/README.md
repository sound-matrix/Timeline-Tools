# Browser verification

Run against an isolated Supabase test project (or a dedicated disposable user). Browser tests create real queued jobs and Storage objects. Provision and confirm a normal user, then set `TEST_EMAIL` and `TEST_PASSWORD` in ignored `.env.test.local`. Configure `.env.local` as described in the root README.

```sh
npx playwright install chromium
npm run build
npm run test:e2e
```

The configuration starts the production app on port 3100. If using a preinstalled Chromium executable, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. The user suite signs in, queues all three tools, checks the dashboard and mobile overflow, verifies admin denial, and signs out. Use `--grep` to select a suite. Never use a real user's credentials for automated tests.

Clean up jobs first using an authorized test database operator, then remove Storage objects through the Storage API, then delete the test auth user. Never delete Storage metadata directly because that would leave object bytes behind.
