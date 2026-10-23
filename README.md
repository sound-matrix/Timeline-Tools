# Timeline Tools — Phase 1A

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
<a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=email">Confirm your email</a>
```

**Reset password:**

```html
<a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery">Reset your password</a>
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

`uploads` and `outputs` are private. Paths are `USER_UUID/FILE_UUID.extension`. Accepted extensions: WAV, MP3, M4A, FLAC, AAC, OGG, MP4, MOV, MKV, WEBM. Files must be non-empty. Application limits use MiB (1,048,576 bytes), labeled MB in the prototype UI.

Set the Supabase project's global Storage upload limit high enough for the largest offered plan (seed Studio: 10,000 MiB), subject to your Supabase subscription. The effective ceiling is the smaller of the platform limit and the configured plan limit. Uploads bypass Vercel request-body limits by going directly to Storage.

Storage initially probes permissions without measured file size. RLS checks identity, folder, extension, active account and plan; `private.enforce_upload_limit` additionally checks server-measured final metadata on `storage.objects` INSERT/UPDATE because Storage 1.80 finalization bypasses RLS. Keep this trigger during Storage upgrades and rerun the oversized-upload regression test. Job creation independently checks the uploaded object's measured size and ownership. Clients cannot replace inputs or write outputs. A failed job submission attempts to remove its unreferenced upload.

The Phase 1B worker will populate `duration_sec`, `status`, `error` and `output_paths` (an array of relative output path strings, each under the job owner's folder). Only trusted server workers may modify those fields. Browser clients never receive the service role key. Download links are issued only for the signed-in owner's completed jobs and expire after 60 seconds. Already-issued signed URLs can remain valid until expiry after suspension.

## Vercel

Import this repository with framework **Next.js**, repository root as Root Directory, default `npm run build`, and no static-output-directory override. Set these variables in the desired Preview/Production environments:

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://eicllahlqwnpyfvxtkrr.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Project anon key (or publishable key under this requested variable name) |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only secret, reserved for trusted worker/admin integrations; ordinary Phase 1A requests use user sessions and RLS |

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

## Phase boundary

Jobs stay `queued`. There is no worker, audio processing, transcription, billing checkout, coupon redemption, automatic monthly renewal, or minute deduction in Phase 1A. Prices/allowances are editable configuration. Audio Drama Studio is outside this phase and remains in the preserved prototype only.
