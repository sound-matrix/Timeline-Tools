# Validation and acceptance boundaries

Node 22.23.4: npm ci, 184 npm tests, typecheck and production build pass.
The database tests execute all migrations in PGlite (real PostgreSQL compiled to
WASM) and check cross-user reads/saves/asset registration, missing/foreign assets,
source ownership, duplicate saves, version retention and shared cloud billing.
`npm run test:rls` runs these tests too. External PostgreSQL/psql checks are skipped
without DATABASE_URL; no production database was used.

Python: 54 unittest tests run, 53 pass and one opt-in real-ASR/model test skips.
pytest: 53 pass, one skip, 118 subtests pass. Editor-specific tests cover Storage
path traversal/ownership, snapshot validation, insert passthrough and actual
ffmpeg output with overlapping fades and equal-power pan.

Browser fixture suite: 19 pass in 59.5 seconds, including WAV and MP3 export, in Chromium Headless Shell 140 (full Chromium's
Unix sockets are restricted here). Covers both source entry links, a blank full
page project, OS DataTransfer drop of three independent files, split/move/fade,
undo/redo, save/reload, WAV download and the existing Clean-up/Master/Subtitles/
Studio/Podcast regressions. Live Supabase/Modal are not contacted by fixtures.
MP3 encoding is validated with ffprobe in the editor scenario.

Numerical parity: the browser renders the actual Python fixture using the shipped
OfflineAudioContext graph and compares samples to a real worker-rendered WAV.
RMS difference: -143.34 dB, against a requirement below -60 dB. Fixture includes
linear/equal-power fades, overlapping regions, gain and -3 dB equal-power pan.
This is audio-fixture parity, not certification of Podcast boundary edits/video.

20 tracks / 500 regions / one-hour timeline, 135,769-byte arrangement:
p50 16.7 ms, p95 16.7–16.8 ms, max 16.8 ms across repeated shared-container runs.
The latest p95 was 16.8 ms. The 20 ms CI budget passes; the strict 16.7 ms local
target is not consistently met, and target-device certification remains outstanding. Historical main-branch numbers
are not substituted for this result. E0 GitHub Actions run 40082699539 passed all
three jobs (check, worker, desk); desk logged the same p95 16.8 ms, with 14 browser
tests at the E0 stage.

A follow-up browser regression pauses peak generation, reloads the page, then
checks that the original audio resumes, exactly one region is saved, and its
local WAV contains nonzero samples. A playback unit regression checks the exact
seek offset and that a live region edit leaves unrelated voices running.

Bounded PCM experiment: twenty independent logical one-hour stereo 48 kHz WAV
URLs, three seeks at 0/1200/2400 seconds, real range decoding and playback cache.
The latest Chromium run retained 64 windows / 122,880,000 bytes (117.2 MiB),
issued 240 range requests with a maximum 960,000-byte request, and sampled
5,917,708 bytes of JS heap. This measures retained decoded windows, not total
browser RSS. Silence is synthesized only for requested ranges; no hour-long
compressed imports or 8 GB target-device memory certification is implied.

A dedicated CI job runs the Editor functional suite in Firefox and WebKit.
WebKit uses a fresh persistent profile per test, matching normal Safari storage.
Playwright's ephemeral/private WebKit sessions reject IDB File/Blob writes:
https://github.com/microsoft/playwright/issues/42795. CI reproduced that exact
"Error preparing Blob/File data" response. The Editor now reports the request
error and transaction abort without crashing; a regression aborts a journal
write, checks the Editor stays usable, then retries and saves one region.
Private contexts that reject local audio storage cannot guarantee reload recovery.
Local Firefox crashes during page creation in this container; local WebKit lacks
system dependencies, so CI provides those engine checks. See PR #16 for the
latest CI run. WebKit coverage does not replace released Safari on the target Mac.

Video follow-up: paused seeks and running jumps now map edit-ruler time to the
edited audio output and original source video. A new cross-engine browser
scenario checks source seeks, audio source offsets, inserted-silence frame hold,
resume, stop/return and decoded-frame drift using the actual 15 fps MP4 fixture.
Chromium run 40105471829 passed all 20 browser tests; its decoded-frame p95 was
30.7 ms on the 15 fps fixture, with a 1.02 s source-time error during a cut jump.
WebKit's p95 was 137.3 ms against a 66.7 ms one-frame budget, so that strict check
fails. Firefox required a PulseAudio output in CI and exposed a live-seek gain
curve cancellation error; the follow-up cancels the entire active curve before
starting its short release ramp. Browser verification of that fix is pending.
Do not claim all-engine one-frame behavior from the Chromium p95 measurement.
Local browser downloads were unavailable in this workspace during this follow-up;
Node tests, type checking and the production build pass locally.

Remaining release validation: review cross-engine CI, released Safari/Edge, background-tab scheduling,
source-video sync to one frame, hour-long compressed imports, measured memory for
20 independent one-hour sources on an 8 GB laptop, and live cloud export after
the manual SQL/Modal release. No target-device memory number is claimed. Local
PCM streaming/cache architecture is bounded, but compressed decodeAudioData and
the final output Blob can still be large. Folder drop is optional and omitted.

PRs stay draft until the remaining target-device/cross-browser checks are reviewed.
No production migration, merge or manual deployment was performed.
