# Editor Studio architecture and release

Always fork (brief option b). Source entry links serialize a flush-save before
opening a separate editor_project. Studio/Podcast records keep their original
immutable-source contracts. Podcast word edits/transcript are snapshotted as
non-destructive overlays; there is no send-back operation. Source forks share
cloud export billing with the source, so opening another fork cannot reset the
included export. Blank projects have their own included export. Local exports
never create jobs or consume minutes.

Apply supabase/migrations/20261024093524_editor_studio.sql manually before
releasing this app. The migration is not applied by this work. It adds owner-only
RLS and RPC writes, version retention (last 50 plus hourly checkpoints for 24h),
Editor assets and job snapshots, Storage validation and shared export accounting.
Redeploy timeline-tools-worker manually after review/merge: the worker dispatches
editor_export to workers/editor_export.py. No secrets or environment changes.

The v2 schema is retained. Existing lane colour, inserts, master gain, tempo,
time_signature, loop and markers are reused. The optional editor_project flag
permits empty blank projects and a 1,000,000-byte arrangement budget. Each new
clip has an optional asset UUID. Studio/Podcast continue using their 512 KiB
budget and source immutability. Editor source material can total 80 hours while
output length stays capped at four hours (20 one-hour tracks fit that budget).

The current plans have max_file_mb but no independent total-storage allowance.
This migration explicitly reuses max_file_mb as both the per-file and aggregate
Editor quota. Final uploads lock the owner's profile before counting actual
Storage metadata, including peaks and unfinished assets. This is intentionally
conservative; no new plan prices/allowances are invented. The UI displays both
limits. Existing non-Editor Storage limits remain unchanged.

PCM WAV import is bounded: peak extraction/hash runs in a worker and preview
reads five-second PCM ranges. Compressed formats use native decodeAudioData,
convert to float WAV in acknowledged 65,536-frame worker messages and release
the decoded source afterwards. Cache keys include owner, SHA-256 and rate.
Large compressed files still require a full native decode; memory for the
20-track/hour scenario needs measurement on an 8 GB target laptop. Folder drops
are not implemented. Imported canonical WAVs can exceed the compressed original's
size and must fit the displayed plan quota.

The lookahead tick runs in a dedicated worker (25 ms / 100 ms scheduling window),
with 8-second prefetch and bounded five-second PCM reads. Active edits invalidate
only changed region schedules. Track/master changes use short gain ramps;
stop/seek release voices with a 5 ms ramp on a separate gain node, leaving
immutable fade curves untouched (required by Firefox). The playback clock is clamped to the
requested seek position during the initial scheduling lead-in, so a seek does not
replay the preceding 40 ms. The browser may throttle even dedicated
workers in heavily suspended tabs; target-device/background-tab verification is
still required. PCM window cache holds at most 64 windows (about 117 MiB for
48 kHz stereo float windows), plus active sources and graph nodes.

IndexedDB commits the original File and placement journal before showing a new
region. Reload resumes peak generation/conversion with the same region ID; the
completed canonical audio/peaks manifest replaces that journal only after its
transaction commits. Pending arrangements and completed import blobs survive
reload too. Server saves wait until every referenced asset is registered, retain
the local draft and show Saving rather than misreporting an upload as offline.
Saves debounce for 2 seconds, flush on blur/visibility/pagehide and retry on
online; users can retry Save. Revision conflicts load a server snapshot, keep the local draft, and show
Keep mine (default) / Keep theirs. Restoring a version is a normal undoable edit.

The timeline retains a grid bitmap separately from cached region/waveform tiles
and the playhead overlay. Edits reuse the grid; viewport, ruler, tempo and scale
changes invalidate it. Worker and main-thread painters share the same renderer.

OfflineAudioContext renders bounded blocks with the shared fade/pan formulas.
WAV encoding and lamejs MP3 encoding run in a dedicated worker. The unmodified,
replaceable lamejs 1.2.1 encoder, LGPL license and source notice are under
public/daw/vendor. Cloud exports use immutable DB snapshots and success-only
worker_prepare/worker_complete accounting. Source paths are verified before
service-role downloads. PluginSlot[] is typed but empty; insertChain is a real
passthrough node and apply_inserts is a no-op that rejects unimplemented slots.

Audio scheduling uses the AudioContext render clock; video and the playhead use
getOutputTimestamp projected onto performance time, accounting for output-device
buffering. Invalid, stale or future timestamps use currentTime less reported
base/output latency. Initial video playback waits for the audio's presentation lead-in.
Podcast video consumes a mutable source-clock sample on every playback frame;
React transport labels remain capped at 10 Hz. Paused seeks update the preview,
running seeks restart the edited audio arrangement at the remapped output time,
and inserted silence pauses the video on its source frame. Native pending seeks
settle before another correction. Continuous drift seeks are limited to the
15 fps proxy frame rate, large cut jumps bypass the throttle, and only one native
play request may be pending. The preview switches media only at clip edges.

Validation evidence and remaining acceptance limits belong in VALIDATION.md.
