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
| Master    | Five ffmpeg `equalizer` bands at 60/250/1k/4k/12k Hz, `acompressor`, measured two-pass `loudnorm`; remeasure output true peak and LUFS, attenuate overshoots                                                                | 24-bit WAV + measured JSON report. Silence has null LUFS/peak. Target loudness may be limited by dynamics/peak ceiling; actual output measurements are authoritative.                                                                                                                |
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

### Phase 1C: user-selected processing

Job forms (including dashboard clean-up) start with every processing toggle off and every numeric/language/format choice empty. Start stays enabled until submitting/running. Clicking validates the file and merged settings inline. Blank controls use the submit-time defaults below. Preset chips only fill the loudness field after a click; they never enable a stage. Turning a stage off removes its parameters from the queued settings.

Master settings are strict nested objects: `loudness`, `limiter`, `compressor`, and `eq`. Each is either `{ "enabled": false }` or an enabled object with all required parameters. At least one stage must be enabled. `/api/jobs` uses `jobSchema`, with the same validation mirrored in Python. Legacy flat master settings fail with `invalid_settings`; submit-time defaults fill omitted fields; explicit invalid values still fail.

- Loudness: numeric `lufs` −70…−5. Limiter: numeric `ceiling` −6…0 dBTP, `knee` soft/hard, `release` 50…1000 ms.
- Compressor: `threshold` −60…0 dB, `ratio` 1…20, `attack` 0.01…2000 ms, `release` 0.01…9000 ms, `knee` soft/hard, and `makeup` `{ "mode": "auto" }` or `{ "mode": "manual", "gain": -24…24 }`. Auto makeup estimates half the gain reduction at 0 dBFS.
- EQ: exactly five `bands` at 60/250/1000/4000/12000 Hz, each disabled or enabled with `gain` −12…12 dB (Q=1). Enabling EQ requires at least one enabled band.
- Worker order: enabled EQ bands → optional compressor → optional measured two-pass loudnorm → optional four-times oversampled limiter. Compressor knee maps to ffmpeg `acompressor` knee 2.828427 (soft) / 1 (hard). The limiter combines the same knee-controlled high-ratio compressor with `alimiter` (auto-level off), measures the final 48 kHz PCM true peak, and attenuates any overshoot. With loudness enabled and the limiter off, loudnorm still has its inherent 0 dBTP safety bound.
- Every master returns measured LUFS/true peak, submitted settings, and requested targets (`null` for disabled stages). Silence reports null measurements. Peak limiting can prevent reaching the requested LUFS; measured results are authoritative.
- Legacy Phase 1C clean jobs use at least one feature and integer strength 0…100; the Phase 1D desk below supersedes this form. Subtitles require a language and at least one of SRT/VTT.

Run `npm test`, `npm run typecheck`, `npm run build`, and `OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 python -m unittest discover -s workers/tests -v`. Schema cases are shared between Zod and Python in `tests/fixtures/processing-settings.json`; Python tests also exercise real ffmpeg custom targets, both knees, stage bypass, hot peaks, and silence. The thread limits keep numerical libraries from exhausting shared test-host resources; they do not change processing settings.

After review/merge, the operator must redeploy the Modal worker to accept the new JSON schema. This PR does not deploy it. Until then, the old worker cannot process new-format master jobs.

## Phase 1D: processing desk and live session

All tools use file → original preview → processing options → **Start Processing**.
Dashboard uses the same Clean-up desk. Options begin disabled and each dropdown
begins at **Choose…**. Turning on a stage uses defaults for omitted choices; Off bypasses it.
At least one actual process must be enabled. Voice enhance needs only its toggle.
Mastering and subtitle settings retain the Phase 1C explicit-choice rules.

Clean-up now submits nested stage settings (not a shared strength):

| Choice | Worker mapping |
| --- | --- |
| Light / Medium / Full | Per-stage `amount`: 30 / 60 / 100, scaled to 0.3 / 0.6 / 1 |
| Off or disabled toggle | `{enabled: false}`; process is bypassed |
| Speech+music keep | Adaptive spectral gating (`stationary=False`), full bandwidth |
| Speech focus | Adaptive spectral gating plus 100 Hz high-pass and 8 kHz low-pass |
| Aggressive | Stationary spectral gating (`stationary=True`) |
| De-hum | 50/60/100/120 Hz notches; attenuation scaled independently by its amount |
| De-reverb | Downward gate scaled independently by its amount; reduces room tails, not neural dereverberation |
| Voice enhance | Toggle applies the speech high-pass / presence curve (90 Hz, +3 dB at 3 kHz) |

Example: `{noise:{enabled:true,method:"speech_music",amount:60},hum:{enabled:true,amount:30},reverb:{enabled:false},voice:false}`.
Zod and Python reject incomplete or extra settings. The worker and API continue
to accept Phase 1C `{noise,hum,reverb,voice,strength}` jobs unchanged.

The live session shows Uploading → Starting → Queued → Processing → Done/Failed
without leaving the page. `/api/jobs/[id]` uses the normal authenticated client,
RLS plus an explicit owner filter, and `private, no-store`. It returns status,
measured audio duration when available, errors, and app download routes, never
private object paths. Polling runs every 2.5 seconds without overlapping requests,
pauses in hidden tabs, aborts on unmount, and stops on terminal status. Transient
poll failures retain the last known job state and retry. Download routes retain
the existing private, short-lived signed URL checks. Master's measured JSON report
is linked beside the audio. Recent jobs remains history and refreshes on completion.

The waveform is an **activity illustration, not measured progress or an audio
analysis**: queued is a waiting pulse, processing gradually reveals smoother bars,
and only worker-confirmed Done shows a fully clean static wave. Reduced motion
uses a static graphic and status text. Live motion has a pause control, and the
header's decorative animation pauses whenever a session panel is present.

**Operator action: Modal redeploy required before using the new cleanup desk.**
`workers/audio.py` accepts the new nested settings and denoising methods. Redeploy
with `modal deploy -m workers.timeline_tools_worker` in the existing `sound-matrix` workspace; no secrets or SQL changes are
needed. This PR does not deploy Modal or merge automatically.

## Audio Studio — script-driven DAW

Upload a UTF-8 TXT/SRT/VTT script, 1–200 audio clips (named or unnamed), and an
optional bed. Speaker tags and per-clip speaker labels are optional; matching
filename prefixes add speaker evidence. No guide/reference input exists. SRT/VTT
timestamps determine script order only. Clips retain their natural speed.

Every new processing choice starts blank: line gap (0–5000 ms), match strictness,
dialogue/master LUFS, room tone on/off and amount, subtitles on/off and formats,
and bed ducking/fit when a bed exists. New settings fill missing choices with documented defaults.
Transport is a flat stored ZIP, manifest **v2** `{version,clips:[{file,name,speaker?}],bed,script}`.
Limits remain 250 MB AND the plan cap, 64 KB script, 300 lines, 1000 characters per
line, 3600 seconds per file and 7200 seconds combined. v1 bundles map `voices` to
clips; their guide member is never extracted, probed, decoded or billed. Completed
`heuristic-v1` reports remain available in a read-only compatibility view.

### Pipeline and billing

1. CPU ffprobe and bounded extraction enforce upload/duration limits.
2. Script-language detection (Indic block recognition + Lingua) and faster-whisper
   language detection on each clip’s first ≤30 seconds of detected speech happen
   **before worker_prepare**. Results below 0.5 are uncertain and flagged. Confident
   mismatches fail with `language_mismatch`, language details and zero charge.
3. Estimate duration from VAD speech plus chosen gaps (bed tail only for extend),
   then call `worker_prepare` before full ASR/mixing. If final placement is shorter,
   lower the billed duration to the final length. Never raise the estimate after
   ASR. Completion charges `ceil(min(estimate,final duration)/60)` atomically.
4. faster-whisper **small**, T4, int8_float16, batch 8, cached `/models` Volume;
   CPU int8/batch 2 fallback. Language is forced and word timestamps enabled.
5. `script-match-v1` normalizes NFKC/script characters, combines character/text
   similarity and speaker evidence, solves monotonic per-clip DP with grouped
   lines/segments, then resolves competing clips by confidence. Clips may be
   shuffled across characters. Scores are evidence, not accuracy guarantees.
6. Place sequentially in script order on per-character lanes, narrator first.
   Missing lines become silent placeholders (minimum 1.5 seconds); unmatched
   segments stay in an unplaced bin. No time-stretch.

Outputs: `arrangement-r1.json`, `report.json`, normalized `stems/cN.wav`, and
100-Hz signed 8-bit min/max `peaks/cN.json`. No preview mix is rendered until the
user chooses export settings. The initial Storage snapshot is immutable; edits
are stored as versioned JSON rows via revision-checked `save_arrangement`.

The DAW shows real peaks with play/pause, seek/draggable playhead, zoom, move/trim,
split/delete/nudge, lane mute/solo/gain, region gain, snap-to-gap, undo/redo,
unplaced placement and a line/confidence report. Autosave waits about two seconds;
409 conflicts stop edits/exports until reload. Browser WebAudio is **preview only**
(dialogue lanes); the bed, ducking, room tone and master are rendered server-side.
Mobile is horizontally scrollable, view-only editing. Reduced motion uses stepped
playhead updates, no smoothing. Original source metadata cannot be changed by saves.

### Export

`studio_export` captures the parent’s arrangement revision at queue time. MP3:
128/192/256/320 kbps, 44.1/48 kHz. WAV: 16/24/32f, 44.1/48/96 kHz. Choose one or both
formats, subtitle formats/none, and whether to exclude or mark missing lines;
encoding controls are never preselected. The worker applies trims, gains,
mute/solo, bed trim/loop/extend, ducking, room tone from quiet clip regions, and
chosen dialogue/master LUFS. Output length is the arrangement length.

**The first successful export is included.** Re-exports charge
`ceil(arrangement duration/60)` minutes. A parent-row lock reserves at most one
free in-flight export, preventing concurrent free renders. Failed exports charge
nothing and release the free reservation. Exports have unique marker input paths;
the original upload uniqueness constraint is retained. Render settings and the
arrangement snapshot are server-validated. Audio is never mixed for export in the
browser. See [billing details](docs/studio-daw/BILLING.md).

### Release and verification

Do not merge or deploy automatically. After merge, a human must apply
`supabase/migrations/20261024003917_studio_daw.sql` and redeploy
`timeline-tools-worker`, including its T4 ASR function and model Volume. Coordinate
app/worker rollout before accepting v2 sessions. No live migrations, secrets,
Cashfree, prices or other desks are changed by this implementation.

Run `npm test`, `npm run typecheck`, `npm run build`,
`python -m unittest workers.tests.test_studio`, and the isolated desk suite:

```sh
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54331 \
NEXT_PUBLIC_SUPABASE_ANON_KEY=desk-test-key npm run build
npx playwright test --config=playwright.desk.config.ts
```

ASR is mocked in default unit tests. `STUDIO_REAL_ASR=1 python -m unittest
workers.tests.test_studio.Pipeline.test_real_tiny_asr` opts into a real tiny model
download. Model accuracy and GPU COGS need a real speech benchmark after the human
worker rollout; no measured GPU cost is claimed from fixture tests. See
[ASR and COGS](docs/studio-daw/ASR-COGS.md).


### Submit-time defaults and optional scripts

`workers/defaults.json` is the canonical defaults fixture; `lib/defaults.ts` and
`workers/defaults.py` apply it before strict validation. Controls remain blank;
placeholders/help name the defaults. The API and worker independently reapply them.
Explicit out-of-range values fail inline on click. Start Processing is disabled
only while submitting or while a job is queued/processing. Missing files show an
inline alert. Legacy queued cleanup/Studio bundles retain support.

| Tool | Blank selection behavior |
| --- | --- |
| Studio | 300 ms gap, normal matching, dialogue −18 LUFS, master −16 LUFS, room tone off, subtitles off; with bed: 12 dB ducking, trim |
| Clean-up | If no stages selected: noise speech/60%, hum 30%, reverb off, voice on. Enabled stage missing amount: 60%; noise method: speech |
| Master | If no stages selected: −16 LUFS, limiter −1 dBTP (soft knee, 180 ms); compressor/EQ off |
| Enabled master stage | Loudness −16; limiter −1/soft/180; compressor −24 dB, ratio 3, attack 20 ms, release 180 ms, soft, auto makeup; enabled EQ band 0 dB |
| Subs | Auto-detect language, SRT |
| Studio enabled options | Room tone 60%; subtitles SRT |
| Export | MP3 320 kbps/48 kHz; WAV 24-bit/48 kHz. No format chosen: MP3; subtitles off; missing lines excluded |

Studio manifest v2 accepts `mode: "script" | "transcribe"`, with `script: null`
for automatic transcription. v1 and older script v2 bundles are still accepted.
Malformed scripts require an explicit ignore-script confirmation before submission.
Without a script, clips are transcribed in order, arranged on speaker/file-stem
lanes with the chosen gap, and shown in the read-only click-to-seek transcript.
Language checking happens only with a script: probe/decode → optional language
gate → worker_prepare → ASR → arrangement. Before worker_prepare, failures charge
zero. No SQL migration is needed: script/mode live in the existing stored manifest.
A human redeploys Modal after merge. Do not merge or deploy without owner approval.

### Podcast

`/podcast` adds multi-recording clean-up, automatic word transcription and speaker
lanes, editable transcript/EDL, synchronized video preview, and audio + subtitle
exports. The first successful export is included; re-exports charge edited output
length. See [Podcast setup, defaults, migration and verification](docs/PODCAST.md).
No SQL or Modal deployment is run by this change.

### Editor inserts and projects menu

Editor Studio is a top-level Workplace menu item at `/editor`. This page lists the
signed-in owner's projects and supports new, open, rename and delete. Delete
archives the project from this list rather than breaking export/billing foreign
keys; export snapshots and existing asset retention remain intact. Studio and
Podcast keep their existing **Open in Editor Studio** actions.

Playback and local/cloud render now use this order: region inserts → track
inserts → track gain/pan → master gain → master inserts → output. Moving the
master gain before its inserts lets the Ceiling limiter contain a boosted mix.
Parameter edits update the current graph; insert addition, removal, reorder,
bypass and tempo changes rebuild it. Every region has a stable input so adding
clip inserts while a source is playing does not need to restart that source.
The Mixer displays the master rack, including Ceiling's ceiling/release controls
and live compressor gain-reduction meter. The ceiling is a sample ceiling, not
an independently certified broadcast true-peak measurement.

Deployment: apply `20261025081235_editor_project_delete.sql` before deploying the
web app (the list requires `archived_at`). Existing master/track insert JSON needs
no migration. Redeploy the audio worker with
`modal deploy -m workers.timeline_tools_worker` to pick up the corrected insert
order and normalization ceiling in cloud exports.
