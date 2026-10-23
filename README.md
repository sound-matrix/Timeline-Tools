# Timeline Tools — Phase 1B

Next.js App Router + TypeScript + Supabase. The original white/indigo layout and controls are retained; the unmodified static demo lives in `prototype/`.

## Included

- Email/password signup, confirmation, signin, signout, neutral forgot-password feedback, and recovery using `token_hash` + `verifyOtp`.
- Authenticated dashboard and Clean-up, Mastering, Subtitles pages. Uploads go directly to private Storage (resumable TUS above 6 MiB); validated settings persist with each queued job.
- Own-job listing with real status and short-lived signed output downloads. No simulated processing, fake reports, or sample exports.
- Server-checked `/admin`: plans/pricing, per-plan file and minute limits, top-up packs, coupons, user plan/credits/suspension, jobs, audit log. Deactivate packs/coupons/plans using Active. Privileged accounts are protected from the user credit/suspension editor.
- RLS on every application table; ownership policies on both private buckets. Users can update **only** `profiles.display_name`, using a column grant; no table-wide profile UPDATE grant exists.
- Admin changes use a narrowly scoped RPC with a fresh database role check. Its SECURITY DEFINER implementation is in the unexposed `private` schema; the public wrapper is SECURITY INVOKER. Database triggers write before/after audit records in the same transaction. Clients cannot alter audit records.

## Local setup

Use Node.js 22 or newer.

```sh
npm ci
cp .env.example .env.local
# Fill in keys from your Supabase project settings (never commit them).
npm run dev
```

Project: `eicllahlqwnpyfvxtkrr` (TimelineTools). The migrations were applied to this project during implementation. The repository migration versions match its recorded migration history. For a new project, run all migrations in order, using the Supabase CLI:

```sh
npx supabase init
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push
```

Review `supabase migration --help` / `supabase db --help` for the installed CLI. Do not re-run migration SQL manually on the existing project.

### Auth dashboard configuration (required before launch)

Enable Email provider and email confirmation. Set Site URL to your deployed origin, and allow redirect URLs for `http://localhost:3000/auth/confirm` and each trusted deployed origin's `/auth/confirm` (including explicitly trusted preview origins).

Configure SMTP for real delivery. In Authentication → Email Templates, use these links:

**Confirm signup:**

```html
<a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=email"
  >Confirm your email</a
>
```

**Reset password:**

```html
<a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery"
  >Reset your password</a
>
```

The app supplies `window.location.origin + '/auth/confirm'` as RedirectTo; no deployment origin is hard-coded. The callback only accepts email/signup/recovery types and routes recovery to `/reset-password`; it never follows an arbitrary `next` URL. Configure Supabase's password policy to at least 10 characters to match the form. Supabase rate limits remain in effect. Email template/SMTP settings are not changed by database migrations.

### First owner

Sign up and confirm your real account, then an authorized database operator can bootstrap that exact account in Supabase SQL Editor:

```sql
update public.profiles
set role = 'owner'
where id = (select id from auth.users where email = 'YOUR_CONFIRMED_EMAIL');
```

Verify the ID before executing. Never derive roles from signup metadata. Later admin/support/owner assignment is a database-operator task in Phase 1A; there is intentionally no public self-service role editor. `support` has ordinary own-account access; only `admin` and `owner` enter the CMS.

### Storage and limits

`uploads` and `outputs` are private. Inputs use `USER_UUID/FILE_UUID.extension`; outputs use `USER_UUID/JOB_UUID/filename`. Accepted extensions: WAV, MP3, M4A, FLAC, AAC, OGG, MP4, MOV, MKV, WEBM. Files must be non-empty. Application limits use MiB (1,048,576 bytes), labeled MB in the prototype UI.

Set the Supabase project's global Storage upload limit high enough for the largest offered plan (seed Studio: 10,000 MiB), subject to your Supabase subscription. The effective ceiling is the smaller of the platform limit and the configured plan limit. Uploads bypass Vercel request-body limits by going directly to Storage.

Storage initially probes permissions without measured file size. RLS checks identity, folder, extension, active account and plan; `private.enforce_upload_limit` additionally checks server-measured final metadata on `storage.objects` INSERT/UPDATE because Storage 1.80 finalization bypasses RLS. Keep this trigger during Storage upgrades and rerun the oversized-upload regression test. Job creation independently checks the uploaded object's measured size and ownership. Clients cannot replace inputs or write outputs. A failed job submission attempts to remove its unreferenced upload.

The Phase 1B worker populates `duration_sec`, `status`, `error` and `output_paths` (an array of relative output path strings, each under the job owner's folder). Only trusted server workers may modify those fields. Browser clients never receive the service role key. Download links are issued only for the signed-in owner's completed jobs and expire after 60 seconds. Already-issued signed URLs can remain valid until expiry after suspension.

## Vercel

Import this repository with framework **Next.js**, repository root as Root Directory, default `npm run build`, and no static-output-directory override. Set these variables in the desired Preview/Production environments:

| Variable                        | Purpose                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `NEXT_PUBLIC_SUPABASE_URL`      | `https://eicllahlqwnpyfvxtkrr.supabase.co`                                                             |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Project anon key (or publishable key under this requested variable name)                               |
| `SUPABASE_SERVICE_ROLE_KEY`     | Server-only secret; never expose to the browser; ordinary app requests still use user sessions and RLS |

Redeploy after changing public variables; Next.js embeds them at build time. `.env.example` contains no keys. Do not put the service key in any `NEXT_PUBLIC_*` variable.

## Verification

```sh
npm test
npm run typecheck
npm run build
# Requires psql and a local/test Supabase PostgreSQL connection:
DATABASE_URL='postgresql://...' npm run test:rls
```

`supabase/tests/rls.sql` creates temporary test accounts inside a transaction and rolls back all fixtures. It asserts cross-user profile/job/storage isolation; rejection of role/plan/credit/suspension escalation and job status forgery; admin RPC rejection for users; oversize/output-write denial; audited admin credit changes; and suspended-user denial. Use a test database; fixture IDs are fixed.

Run the opt-in browser tests with the environment described in `tests/README.md` for actual upload, settings persistence, admin forms, and recovery-token checks.

## Phase 1B worker and deployment runbook

The primary path is a **Modal scheduled poll every 30 seconds**. No public worker endpoint and no trigger-on-insert webhook are needed. One invocation claims one oldest queued job; up to four containers can overlap. Queue latency grows at capacity. All input/output buckets remain private. Only worker RPCs change statuses and charge minutes; browser grants are unchanged.

| Where                                  | Variable                                | Notes                                                                      |
| -------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------- |
| Vercel (existing)                      | `NEXT_PUBLIC_SUPABASE_URL`              | Public project URL                                                         |
| Vercel (existing)                      | `NEXT_PUBLIC_SUPABASE_ANON_KEY`         | Public anon/publishable key                                                |
| Vercel                                 | `SUPABASE_SERVICE_ROLE_KEY`             | Server only; never `NEXT_PUBLIC_*`                                         |
| Vercel (optional)                      | `MODAL_JOB_WEBHOOK_URL`                 | Not used by this polling implementation; leave unset                       |
| Modal secret `timeline-tools-supabase` | `SUPABASE_URL`                          | `https://eicllahlqwnpyfvxtkrr.supabase.co`                                 |
| Modal secret `timeline-tools-supabase` | `SUPABASE_SERVICE_ROLE_KEY`             | Worker-only privileged database/storage access                             |
| Operator shell                         | `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` | Deployment credentials for workspace `sound-matrix`; never print or commit |

### Release order

1. Review and apply **only** `20261023025214_modal_audio_worker.sql` to the existing project. Phase 1A migrations are already applied. Link the CLI to `eicllahlqwnpyfvxtkrr`, check `npx supabase migration list`, and use `npx supabase db push --dry-run` before `npx supabase db push`. The dry run must list only the new Phase 1B migration. Stop if old migrations appear; reconcile history rather than reapplying them. This PR does not auto-apply migrations or auto-deploy Modal.
2. From the repository root, install the pinned worker dependencies in an isolated Python 3.12 virtualenv:

   ```sh
   python -m venv .venv
   . .venv/bin/activate
   python -m pip install -r workers/requirements.txt
   ```

3. Ensure the operator shell has the Modal token pair **for `sound-matrix`** and the Supabase URL + service-role key. Do not paste values into commands, screenshots, logs, or shell history. Create the Modal secret from the environment without putting secrets in command-line arguments:

   ```sh
   python - <<'PYSECRET'
   import os
   import modal
   values = {key: os.environ[key] for key in
             ('SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY')}
   modal.Secret.objects.create('timeline-tools-supabase', env_dict=values)
   PYSECRET
   ```

   Alternatively, create `timeline-tools-supabase` in the Modal dashboard for workspace `sound-matrix`, with those two keys. If it already exists, update it there. The Modal token pair belongs only in the operator shell, not the deployed worker secret. Confirm the workspace in Modal before deployment; the token determines which workspace receives the app.

4. Deploy and inspect schedule health:

   ```sh
   modal deploy -m workers.timeline_tools_worker
   # Optional immediate invocation after deployment:
   modal run -m workers.timeline_tools_worker::poll
   ```

   In Modal Apps → `timeline-tools-worker`, verify `poll` has the 30-second schedule and no missing-secret/image-build errors. First subtitle job downloads Whisper small into persistent volume `timeline-tools-asr-models`, so its cold start takes longer. This v1 uses 2 CPU cores / 4 GiB, no GPU. Worker hard timeout: 60 minutes.

5. Deploy the Next.js PR through the normal Vercel flow. Submit a short recording at <https://timelinetools.vercel.app>, first with Clean-up, then Mastering and Subtitles. Watch Recent jobs refresh from `queued` to `processing` to `done`. Download each result and open/play it; for Mastering also inspect `loudness-report.json`. Test all requested subtitle languages with real speech before production use.
6. Verify the profile balance decreased by the expected amount, and confirm failed jobs charge nothing. Check Modal logs and the CMS jobs queue. Inspect `started_at`, `finished_at`, `minutes_charged` and `worker_id` with a trusted operator connection if troubleshooting.

### Atomic transitions and billing

- `worker_claim`: oldest `queued` row with `FOR UPDATE SKIP LOCKED` → `processing`, unique worker token, start time. Requires an active account/plan and at least one available minute.
- Download from private `uploads`; ffprobe measures duration. `worker_prepare` records duration and checks `ceil(duration_sec / 60.0)` against balance **before heavy processing**. A positive fractional minute costs at least one minute. Zero-length/non-finite media fails safely.
- Upload private results under `{user_id}/{job_id}/…`. `output_paths` is an array of relative object paths, compatible with the existing 60-second signed-download API. Masters include a WAV and JSON report; subtitles include requested SRT and/or VTT.
- `worker_complete` locks the processing job, verifies worker identity, owner-prefixed paths and uploaded objects, then conditionally deducts from the profile and marks `done` in **one transaction**. Balance cannot go negative. Concurrent jobs may both pass preflight, but only those still affordable at completion succeed. No temporary reservation or failure charge exists.
- Duplicate completion or a late worker on a failed/done job is a no-op: no double charge. `error` remains null on success. Failure messages come from a fixed safe allowlist; HTTP exceptions/keys/stack dumps are never copied into jobs.
- In-process failures attempt private-output cleanup. If a completion response is lost, the worker checks job state before deleting files; uncertain outcomes preserve files for reconciliation. Hard-killed invocations are marked failed by a later poll after a 2-hour grace period and are **not automatically requeued**. Users can submit a new job. Operators may remove private orphan objects for failed jobs after checking they are not referenced by a done job. Pause/delete the Modal deployment to stop the poller; resume after fixing the cause. Existing completed jobs remain downloadable.

The SECURITY DEFINER implementations stay in `private`, with empty `search_path`. Narrow public SECURITY INVOKER wrappers and private functions grant EXECUTE **only to service_role**. No client status/balance/result UPDATE grants were added.

### Processing choices and limitations

| Tool      | Exact v1 pipeline                                                                                                                                                                                                           | Output / limitations                                                                                                                                                                                                                                                                 |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Clean-up  | ffmpeg decode to 48 kHz stereo PCM; `noisereduce` non-stationary spectral gating in 20-second chunks; ffmpeg `equalizer` notches at 50/60/100/120 Hz, conservative `agate` for room tails, highpass + presence EQ for voice | 24-bit WAV. Strength scales all enabled controls. Room-tail gating approximates de-reverb; it cannot reconstruct a dry voice. Strength 0 skips effects. Very short final denoise chunks pass through. No neural denoiser fallback: processing failures fail safely without charging. |
| Master    | Only enabled stages: selected 60/250/1k/4k/12k Hz EQ bands → user compressor → measured two-pass `loudnorm` → oversampled true-peak limiter; remeasure output                                                               | 24-bit WAV + measured JSON report. Silence has null LUFS/peak. Target loudness may be limited by dynamics/peak ceiling; actual output measurements are authoritative.                                                                                                                |
| Subtitles | `faster-whisper` multilingual **small**, CPU int8, beam size 5, VAD, explicit en/hi/te/ta hint                                                                                                                              | UTF-8 SRT/VTT. Good-enough v1 transcription; accents, music, overlap and low-resource languages need human review. No translation, diarization or manual transcript editor yet.                                                                                                      |

Runtime dependencies are pinned in `workers/requirements.txt`; ffmpeg/libsndfile come from the Debian image. The worker mirrors `lib/settings.ts` validation, including jobs inserted directly through Supabase. Large inputs stream to/from disk; spectral gating is chunked. Very long files can still exceed CPU/disk/runtime capacity and fail without charging.

## Motion and product boundary

The marketing `/` is statically rendered. Its small client loader imports GSAP + ScrollTrigger + Lenis and the canvas renderer **after browser idle**, and only when motion is allowed. No motion packages are loaded by the studio forms. Canvas is capped at 1.5× pixel ratio / ~30 fps, runs only in view, and stops in hidden tabs. Cleanup removes ticker callbacks, observers, events, ScrollTriggers and Lenis on navigation or pause. There is a landing pause control; live reduced-motion preference changes tear down heavy motion and retain all text/navigation/static visuals.

Studio effects are small CSS illustrations, explicitly labeled as illustrative. Processing waveform rows are tied to the actual `processing` state; no fake percentage or completion timer exists. Own-job tables refresh every 5 seconds only while visible and queued/processing. Tool pages include their recent jobs and downloads. Reduced motion disables CSS effects.

`/billing/success?minutes=300` previews rupee coins leaving a wallet, waves returning and a +minutes count. Query values are bounded. The page clearly says **preview**: no verified payment, balance write or checkout is implemented. This animation exists only on that screen. Pricing is the requested static seeded snapshot (Free ₹0 / 30, Creator ₹499 / 300, Pro ₹1,499 / 1,200, Studio ₹4,999 / 5,000), INR only / no GST; update landing copy when CMS prices change. Paid plan activation/checkout, coupons, renewals, Google sign-in and full Audio Drama Studio remain out of scope. `prototype/` stays untouched. No FilmyAI changes.

## Phase 1B verification

```sh
npm test                      # Includes embedded PostgreSQL worker/RLS suite
npm run typecheck
npm run build
python -m unittest discover -s workers/tests -v
npm run test:e2e -- tests/browser/motion.spec.ts
```

`tests/worker-db.test.mjs` runs all migrations and the existing RLS fixture against disposable PGlite PostgreSQL with minimal Supabase auth/storage schema stubs. It checks RPC denial for anon/users, protected column grants, claim identity, duplicate completion/no double charging, output folder checks, insufficient credits, competing preflight jobs, failure sanitization, timeout and own-row/output reads. It does not replace tests against real Supabase Storage or simultaneous multi-connection load. `npm run test:rls` remains available for the original RLS suite against a disposable real Supabase database.

Python tests exercise real ffmpeg clean/master/probe pipelines, silence-safe measurements, all four ASR language hints and SRT/VTT formatting (ASR inference mocked), schema rejection, and preservation of successful outputs after a lost completion response. Browser motion tests cover mobile/desktop overflow, pause/resume, navigation cleanup, reduced motion, static no-JS content and billing preview bounds. Live upload → Modal → Supabase → download smoke tests require deployment credentials and a confirmed test user; do not claim them as passed from the local tests.

## Phase 1C: explicit processing choices

All forms, including the dashboard uploader, start with no selected processing options or numeric values. Submit stays disabled with “Select your options above.” until the selected tool is complete. Loudness preset buttons fill the target only on click and remain editable. Subtitle language and SRT/VTT formats must be selected; clean-up requires at least one feature and an integer strength from 0–100.

Master `settings` now contains four strict stage objects: `eq`, `compressor`, `loudness`, `limiter`. Disabled stages are exactly `{ "enabled": false }` and bypass their filters. At least one stage must be enabled. Enabled stages require:

- Loudness: `lufs`, any number −70…−5.
- Limiter: `ceiling` −6…0 dBTP, `knee` soft/hard, `release` 50…1000 ms.
- Compressor: `threshold` −60…0 dB, `ratio` 1…20, `attack` 0.01…2000 ms, `release` 1…9000 ms, `knee` soft/hard, and `makeup` either `{ "mode": "auto" }` or `{ "mode": "manual", "gain": <−36…36 dB> }`.
- EQ: five `bands` at 60/250/1000/4000/12000 Hz, fixed Q=1. Each band is disabled or `{ "enabled": true, "gain": <−12…12 dB> }`; at least one band must be enabled.

Soft compressor knee maps to ffmpeg `knee=2.828427125`, hard to `1`. Auto makeup, only when selected, applies half the estimated gain reduction at 0 dBFS: `−threshold × (1 − 1/ratio) / 2` dB. Float intermediates preserve boosts before loudness/limiting. The limiter upsamples to 192 kHz, applies a lookahead peak cap with auto-level disabled, and returns to 48 kHz. Its soft mode adds a fast soft-knee peak compressor before the cap; both use the selected release. Only an enabled limiter can trigger post-render overshoot correction.

Loudnorm uses its technical 0 dBTP safety maximum and LRA=50, leaving the separately selected limiter last in the chain. These are algorithm parameters, not hidden user limiter settings. The JSON report records measured output LUFS/true peak, selected settings and targets; disabled targets and nonfinite silence measurements are `null`. Actual loudness can differ when peaks/dynamics constrain the signal. See the [ffmpeg filter reference](https://www.ffmpeg.org/ffmpeg-filters.html) for loudnorm and limiter behavior.

The API already validates through `jobSchema`; Zod and Python share the acceptance/rejection corpus in `tests/fixtures/processing-settings.json`. Old flat master settings fail through the existing `invalid_settings` worker error path before storage access, without charging. No schema migration or environment changes are required. After merge, the operator must redeploy the worker before processing the new master settings; this PR does not deploy it.

Validation: `npm test`, `npm run typecheck`, `npm run build`, and `python -m unittest discover -s workers/tests -v`. The Python suite renders custom −18.5 LUFS / −1.5 dBTP with soft knees and a selected EQ band, checks signal-chain order and bypass, hot-signal limiting, silence and legacy rejection. The authenticated browser flow in `tests/browser/studio.spec.ts` requires an isolated confirmed test account.
