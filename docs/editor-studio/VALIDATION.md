# Validation and acceptance boundaries

Node 22.23.4: npm ci, 181 npm tests, typecheck and production build pass.
The database tests execute all migrations in PGlite (real PostgreSQL compiled to
WASM) and check cross-user reads/saves/asset registration, missing/foreign assets,
source ownership, duplicate saves, version retention and shared cloud billing.
`npm run test:rls` runs these tests too. External PostgreSQL/psql checks are skipped
without DATABASE_URL; no production database was used.

Python: 54 unittest tests run, 53 pass and one opt-in real-ASR/model test skips.
pytest: 53 pass, one skip, 118 subtests pass. Editor-specific tests cover Storage
path traversal/ownership, snapshot validation, insert passthrough and actual
ffmpeg output with overlapping fades and equal-power pan.

Browser fixture suite: 18 pass in 58.4 seconds, including WAV and MP3 export, in Chromium Headless Shell 140 (full Chromium's
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
p50 16.7 ms, p95 16.7 ms, max 16.8 ms in the latest shared-container run. The
20 ms CI budget and 16.7 ms p95 local target pass in this run; target-device
certification remains outstanding. The preceding local run had p95 16.8 ms. Historical main-branch numbers
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
6,394,276 bytes of JS heap. This measures retained decoded windows, not total
browser RSS. Silence is synthesized only for requested ranges; no hour-long
compressed imports or 8 GB target-device memory certification is implied.

A dedicated CI job runs the Editor functional suite in Firefox and WebKit.
Local Firefox crashes during page creation in this container; local WebKit lacks
system dependencies. CI results must be reviewed before claiming those engines
pass. WebKit coverage does not replace testing released Safari on the target Mac.

Remaining release validation: Firefox/WebKit CI, Safari/Edge, background-tab scheduling,
source-video sync to one frame, hour-long compressed imports, measured memory for
20 independent one-hour sources on an 8 GB laptop, and live cloud export after
the manual SQL/Modal release. No target-device memory number is claimed. Local
PCM streaming/cache architecture is bounded, but compressed decodeAudioData and
the final output Blob can still be large. Folder drop is optional and omitted.

PRs stay draft until the remaining target-device/cross-browser checks are reviewed.
No production migration, merge or manual deployment was performed.
