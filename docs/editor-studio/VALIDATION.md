# Validation and acceptance boundaries

Current suite: 197 npm tests pass, including deterministic scheduling and Python
parity independent of shell cwd/PYTHONPATH. CI uses Node 22 and Python 3.12; local
Node 24 also passes typecheck. See CI-NOTES.md for the three-failure reproduction
and repeated serial/parallel runs. Production builds pass in CI.
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

Video follow-up: paused seeks and running jumps map edit-ruler time to edited
audio output and original source video. Release automation uses a separate gain
node from fade curves; Firefox's native scenario confirms live seeking succeeds.
Video/playhead use device presentation time, with reported-latency fallback when
an engine supplies an invalid timestamp. Future timestamps are rejected even
when their projection would look plausible. Preview decoding remains native;
thumbnail caches and stable strip props avoid repeat decode work, and small drift
uses throttled rate correction. Continuous seek corrections are capped at the
15 fps proxy rate; cut jumps remain immediate. Only one play request may be
pending. React transport labels update at most 10 Hz.

The cross-engine test checks paused seeks, audio offsets, live jumps, an inserted
silence frame hold, resume, stop/return, and decoded-frame PTS against the actual
15 fps MP4 fixture. Local and valid-timestamp engine budgets remain 66.7 ms.
CI WebKit with a timestamp >100 ms in the future uses a documented 200 ms
(empirical shared-runner ceiling) decoded-PTS allowance and a separate
133.3 ms media-clock diagnostic p95 guard. CI-NOTES.md records the incompatible time-origin
evidence, including the approximately 125 ms difference between the runner’s
reported currentTime and displayed-frame PTS. This is a conditional software-runner presentation allowance, not a
200 ms JavaScript draw budget or certification of released Safari.
Local browser downloads were unavailable during this follow-up; CI supplies
native Firefox/WebKit verification, including three repetitions without retries.

Remaining release validation: released Safari/Edge, background-tab scheduling,
source-video sync to one frame, hour-long compressed imports, measured memory for
20 independent one-hour sources on an 8 GB laptop, and live cloud export after
the manual SQL/Modal release. No target-device memory number is claimed. Local
PCM streaming/cache architecture is bounded, but compressed decodeAudioData and
the final output Blob can still be large. Folder drop is optional and omitted.

PR #16 stays draft until #15 merges, it is rebased onto main, and the resulting
head passes check, worker, desk and editor-browsers. Target-device measurements
remain release acceptance limits; the conditional CI budget does not replace them.
No production migration, merge or manual deployment was performed.
