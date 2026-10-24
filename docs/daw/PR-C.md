# Shared professional timeline — PR C

Base: `550a5ba`. PR D (inserts and mixer) must branch after C is merged. This change does not merge, apply production SQL, or deploy workers.

The default arrangement now retains each uploaded clip's entire source range. Matches choose ordering, lane and an anchor; captions remain source-relative metadata. Same-lane collisions sequence the next full clip with the displayed line gap. `split_by_line` remains an explicit choice. Only wholly unmatched clips enter the bin.

`components/daw/daw-timeline.tsx` is shared by Studio and Podcast. Its canvas renders visible tracks/time, with OffscreenCanvas painting when supported and a main-canvas fallback. PCM windows and peak hierarchies run in workers. The peak cache stores immutable content hashes in IndexedDB. Playback streams bounded five-second windows through track volume/pan and master buses; fade breakpoints are sample scheduled. The stereo pan law is -3 dB equal power for new sessions; v1 migration preserves legacy balance and mastering behavior.

The editor includes the tool palette, command history capped at 200 commands, multiple selection/marquee, trim, razor, fades/crossfades, snapping, musical/time rulers, loop, markers, per-track controls, context commands and keyboard shortcuts. Bounces run in OfflineAudioContext and persist a source recipe, without creating an export/billing job. Autosave uses revision checks and skips identical snapshots.

New Podcast jobs preserve independent cleaned source stems and peaks, avoiding doubled premixed audio for overlapping inputs. Video thumbnails are cached; the preview can float/dock and resize. Word edits retain their source coordinates. Separate edit/output/video clocks map moved regions to their original video positions. Older Podcast jobs retain their original mixed source as one whole region because those jobs did not retain separate stems.

The initial Studio loudness target is measured once into a reference gain. Subsequent exports preserve user faders/fades rather than undoing them with another normalization pass. Both the client and worker read v1 and v2 arrangements. Base source metadata remains immutable; derived bounce recipes refer only to the job's own sources.

## Manual release steps

1. Apply `supabase/migrations/20261024053742_daw_v2_retention.sql` manually. It preserves existing owner RLS/grants, adds private Podcast stem metadata, enables v2 saves, keeps the last 50 Studio snapshots per job, and skips identical saves. Existing histories are bounded during migration, not just on the next edit.
2. **Redeploy the Modal worker after merge.** Both the Studio and Podcast worker modules changed. Production SQL must precede the new worker's stem metadata writes.
3. Merge/deploy is outside this task. Open PR D only after C is merged.

## Validation

- `python -m unittest discover workers/tests`: 52 tests; one opt-in model download/real-ASR test skipped.
- `npm test`: 169 passing tests, including PGlite migration/ownership/revision/retention/source-integrity and billing tests.
- `npm run typecheck` and `npm run build` pass.
- Latest Playwright run: all 14 tests pass, including the strict frame benchmark at 16.7 ms p95 with the worker renderer. Earlier runs recorded 16.8 ms and failed that same unrelaxed threshold. Playwright covers upload/defaults, whole shared desks, move, undo/redo, split, placement, save/export, Podcast words, menu bounce, fades and markers.
- The benchmark uses 20 tracks, 500 regions and a one-hour timeline, with one second of warm-up and five seconds of sampled scrolling/zooming. The arrangement is about 136 KB, below 1 MB. Attachments record actual frame timing for each run.
- The worker DSP test compares fades, equal-power pan, track/master gains and bounce reconstruction against fixed numeric references. Another test ensures independent overlapping Podcast stems mix once.

## Review limits and follow-ups

- Container frame timing has varied between 16.7 and 16.8 ms p95. This is not certification on an M1/i5. Actual results remain attached to the browser test run.
- Full one-hour stereo 48 kHz decoding/peak-generation timing and the 50 ms main-thread/edit latency targets have not been certified on the requested hardware. Browser hierarchies use worker-generated source peaks; source-window decoding and painting are off the UI thread where supported.
- The production-media, one-frame A/V accuracy target still needs a real-media hardware run; fixture tests cannot certify it.
- Existing optional Studio bed/room-tone processing remains on the export path. The editable timeline auditions the dialogue stems; a background bus preview remains follow-up work.
- A bounced clip can be undone and rebuilt; bouncing an already-derived clip is intentionally rejected with an inline message. Nested recipe flattening, and full Podcast word-edit parity after a bounce, remain follow-ups.
- PR D remains separate: plugin schemas/DSP/parity tests, insert UI, mixer view, and the 20-track/three-plugin AudioWorklet CPU/dropout measurement. Automation is not built in C.

C is a draft pending the review limits above; the complete original acceptance checklist is not represented as fully certified.
