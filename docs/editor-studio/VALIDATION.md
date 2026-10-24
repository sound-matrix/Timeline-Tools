# Validation and acceptance boundaries

Node 22.23.4: npm ci, 179 npm tests, typecheck and production build pass.
The database tests execute all migrations in PGlite (real PostgreSQL compiled to
WASM) and check cross-user reads/saves/asset registration, missing/foreign assets,
source ownership, duplicate saves, version retention and shared cloud billing.
`npm run test:rls` runs these tests too. External PostgreSQL/psql checks are skipped
without DATABASE_URL; no production database was used.

Python: 54 unittest tests run, 53 pass and one opt-in real-ASR/model test skips.
pytest: 53 pass, one skip, 118 subtests pass. Editor-specific tests cover Storage
path traversal/ownership, snapshot validation, insert passthrough and actual
ffmpeg output with overlapping fades and equal-power pan.

Browser fixture suite: 16 pass in 55.3 seconds, including WAV and MP3 export, in Chromium Headless Shell 140 (full Chromium's
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
p50 16.7 ms, p95 16.8 ms, max 16.8 ms in this shared container. The 20 ms CI budget
passes; the strict 16.7 ms local target is not met. Historical main-branch numbers
are not substituted for this result. E0 GitHub Actions run 40082699539 passed all
three jobs (check, worker, desk); desk logged the same p95 16.8 ms, with 14 browser
tests at the E0 stage.

Remaining release validation: Firefox, Safari/Edge, background-tab scheduling,
source-video sync to one frame, hour-long compressed imports, measured memory for
20 independent one-hour sources on an 8 GB laptop, and live cloud export after
the manual SQL/Modal release. No target-device memory number is claimed. Local
PCM streaming/cache architecture is bounded, but compressed decodeAudioData and
the final output Blob can still be large. Folder drop is optional and omitted.

PRs stay draft until the remaining strict-target/cross-browser checks are reviewed.
No production migration, merge or manual deployment was performed.
