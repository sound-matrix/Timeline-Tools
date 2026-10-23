# Browser verification

Run against an isolated Supabase test project (or a dedicated disposable user). Browser tests create real queued jobs and Storage objects. Provision and confirm a normal user, then set `TEST_EMAIL` and `TEST_PASSWORD` in ignored `.env.test.local`. Configure `.env.local` as described in the root README.

```sh
npx playwright install chromium
npm run build
npm run test:e2e
```

The configuration starts the production app on port 3100. If using a preinstalled Chromium executable, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. The user suite signs in, queues all three tools, checks the dashboard and mobile overflow, verifies admin denial, and signs out. Use `--grep` to select a suite. Never use a real user's credentials for automated tests.

Clean up jobs first using an authorized test database operator, then remove Storage objects through the Storage API, then delete the test auth user. Never delete Storage metadata directly because that would leave object bytes behind.

### Isolated desk suite (no external account or worker)

This suite runs the production app with a localhost Supabase HTTP fixture. It
covers upload-first ordering, empty choices and gating, dropdown payloads,
lifecycle polling, downloads, failures, reduced motion, responsive layout and
owner-scoped status responses. It never queues a live job or charges minutes.
Build using the same public fixture values before running the separate config:

```sh
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54331 NEXT_PUBLIC_SUPABASE_ANON_KEY=desk-test-key npm run build
npx playwright test --config playwright.desk.config.ts
```

After testing, rebuild with your normal deployment environment. The fixture is
only in `tests/fixtures/studio-api.mjs`, listens on loopback, and is never part of
application routes. A live Modal end-to-end smoke remains an operator check after
redeploying the worker.
