# Editor Studio — PR D

The Editor route uses a fixed full-page workspace. The 48 px project bar carries the transport; a 36 px tool strip and dual ruler sit above the timeline. The clip library and bottom dock are initially closed. Existing Studio and Podcast entry points continue to use the shared timeline without the full-page shell.

Track headers start at 200 px and resize from 160–340 px. New tracks start at 96 px. Drag a row edge or use Alt-wheel for one track; Ctrl/Cmd+Shift+wheel changes all track heights. Ctrl/Cmd+wheel or pinch changes horizontal zoom. The Track Panel is optional. Section blocks support drag reordering, Alt+Left/Right, Alt+D duplication, and Enter to loop. Crossing clips are split at section boundaries before movement; source files remain intact.

Right-click and Shift+F10/Menu open clip, track, ruler or empty-timeline actions. Arrow keys, Home/End, Enter and Escape operate menus. Menus flip inside the viewport, scroll when necessary, restore focus and dismiss on outside click. Gain lines can be dragged with Shape; numerical gain/fade controls remain in Regions.

The Effects dock contains ordered track, clip and master inserts: Shape EQ, Squeeze, Ceiling, Space, Echo, Warmth, Quiet and Silk. Drag card headers or use move buttons; bypass/remove, named presets and parameter values persist in arrangement JSON. Knobs support arrows, vertical drag, Shift for fine movement and double-click reset. EQ nodes also drag directly on the curve. Mixer strips expose level, pan, mute/solo, meters and master limiting. Track FX opens the dock; X toggles it. Sends, automation and routed folder buses are outside this insert-rack implementation; recording and Freeze remain unavailable.

## Audio processing and approximations

Playback and local exports use the same Web Audio graph, in this order: region gain/fades → clip inserts → track gain/pan → ordered track inserts → ordered master inserts → master/reference gain. Cloud rendering uses the same order, IDs, bypass flags and parameter contract with persistent state across half-second blocks.

- EQ: five RBJ peaking biquads; scipy `lfilter` implements the cloud version. Browser frequency controls clamp below Nyquist.
- Space: deterministic sparse stereo room impulse, convolver normalization disabled before loading the buffer. Small/Room/Hall presets vary decay and wet mix. This is a synthetic room, not a measured acoustic model.
- Echo: beat-synced first delay, feedback and wet mix. A shared AudioWorklet uses the same stateful sample recurrence as Python: the first echo is delayed by D rounded samples, and feedback repeats every D + 128 samples. This avoids native feedback-cycle timing differences between Firefox, Chromium and WebKit in both playback and offline export.
- Warmth: normalized tanh shaping with wet mix. Quiet is a simple amplitude gate. Silk is a static high-shelf sibilance reduction, not a dynamic multiband de-esser.
- Squeeze uses native Web Audio compression during playback/local export. Python uses a linked stereo soft-knee detector with attack/release smoothing; this is an approximation of the browser's implementation-defined detector, so dynamics are not bit-identical. Ceiling adds hard clipping at its threshold after compression; master gain follows the insert chain.
- Local export and bounced-clip reads warm up each bounded offline window with up to 60 seconds of preceding audio. This avoids ordinary block-boundary resets without allocating a multi-hour mix buffer. Feedback tails longer than that window are approximated. Cloud export preserves full effect state across blocks and is preferable for very long feedback tails. Export ranges remain explicit; tails outside the chosen range are cropped.
- Response/transfer curves show the selected settings. Spectrum and gain-reduction metering run during playback. The EQ display is a visual approximation of the combined response; processing uses actual biquad filters.

## Database and Modal rollout

Apply **`supabase/migrations/20261025041003_editor_project_rename.sql`** before using inline project rename. It grants only `UPDATE(name)` with active-owner `USING` and `WITH CHECK` policies. Arrangement edits still use the existing revision-locked RPC. Effects, section blocks, reverse flags, track colours and heights use existing JSON; no effect tables or data rewrite are required. Old arrangements receive additive structural defaults when parsed.

Redeploy the existing Modal worker after merge using the repository's normal deployment process. Changes are in `editor_export.py`, `studio_audio.py`, `studio_export.py`, `editor_dsp.py`, `effect_contract.py` and the pinned `scipy==1.17.0` dependency in `workers/requirements.txt`. No live database changes or Modal redeployment were performed for this PR.

The audio-only full-page timeline retains small clip images in a 32 MB raster cache, shared across repeated clips and eight zoom levels per octave. A bounded image pool mounts visible clip tiles; exact scroll/zoom positions use transforms. Headers update through a coarse virtual window, the ruler and playhead are separate, and the existing canvas worker remains available for video/overlay timelines.

## Validation

See `VALIDATION.md` for measured results and environmental limits. `tests/browser/editor-daw.spec.ts` runs in both desk Chromium and the existing Firefox/WebKit workflow; Python worker tests cover actual export with effects/reverse, DSP state across blocks, effect ordering, bypass and malformed parameters. Node tests cover JSON serialization, schema bounds, presets, section splitting/reordering/duplication and owner-only rename permissions.
