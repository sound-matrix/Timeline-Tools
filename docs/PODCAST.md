# Podcast processing and editing

Podcast is a new `/podcast` tool in the Indigo Atelier workplace. It reuses the
Clean-up controls and pipeline, Studio waveform canvas, private Storage buckets,
and existing minute-billing lifecycle. There is no script input.

## Inputs, limits and processing

- Upload audio (WAV, MP3, M4A, FLAC, AAC, OGG) or video (MP4, MOV, MKV, WebM).
- The combined recording bytes plus manifest must fit the current plan's
  `max_file_mb`. Each recording uses the existing resumable uploader. A v2 ZIP
  contains only the manifest, so long video never needs a browser-memory ZIP.
- The worker verifies each reference belongs to the authenticated job owner,
  reads Storage object sizes, rechecks the plan's aggregate size limit, and
  downloads to disk. Original video remains private in `uploads`.
- The plan schema currently has no separate duration entitlement. Available
  minutes are checked by `worker_prepare`; the editor/render budget is four
  hours of input and four hours of output, including mic offsets and inserted gaps.
- Multiple recordings are sequential unless “separate mics” is selected. Mic
  offsets are explicit seconds (blank means zero); the worker delays and mixes
  those tracks. Input billing counts the sum of input lengths, including mics.
- Order: verify/download → length probe → decode → `worker_prepare` → clean/mix
  → video proxies → ASR/diarization → persist → `worker_complete`. Probe/decode
  failures have `invalid_media`; all other Podcast failures use `processing`.
  Errors log only the step and exception class. Failed jobs do not complete or
  deduct minutes; failures before `worker_prepare` charge zero.
- Video audio extraction explicitly uses `-vn` and 48 kHz. Preview proxies are
  at most 720p H.264 MP4 with AAC audio and `+faststart`; video is muted during
  editor playback while the processed audio provides the soundtrack.

## Defaults (controls stay unselected)

`workers/defaults.json`, `lib/defaults.ts` and `workers/defaults.py` are the
canonical shared defaults. API and worker independently apply them before strict
validation. Blank fields never become zero; explicit invalid values still fail.

| Setting | Submit-time default |
| --- | --- |
| Podcast clean-up | If no stages selected: speech noise removal 60%, hum 30%, reverb off, voice on |
| Enabled clean-up stage | Missing amount 60%; missing noise method speech |
| Session mode | Sequential; offsets zero in mic mode |
| Speaker count | Auto (distance threshold for fallback); optional hint 1–12 |
| MP3 export | 320 kbps, 48 kHz; blank format selection means MP3 |
| WAV export | 24-bit, 48 kHz; selectable 16/24/32f, 44.1/48 kHz |
| Transcript export | Off; SRT/VTT and speaker labels are opt-in |
| Bleep / insert silence | 1 kHz, −12 dB / 300 ms; editable explicitly |

The original Studio/Clean-up/Master/Subs defaults from PR A remain documented in
README. API, Python and cross-language fixture tests cover empty and partial jobs.

## Diarization and Modal setup (human only after approval)

`podcast_asr` is a separate T4 function in `timeline-tools-worker`, using the
existing `timeline-tools-asr-models` volume. It runs faster-whisper small with
word timestamps. Words take the speaker turn with maximum overlap (nearest turn
only for boundary gaps). All times/confidences are finite native floats rounded
to six decimals.

With no token, VAD windows feed SpeechBrain ECAPA speaker embeddings on CPU and
agglomerative cosine clustering (automatic distance threshold 0.35 or the user's
speaker-count hint). No gated model or secret is required for this path. Model
weights still need to be downloaded on first use, then remain on the volume.

To prefer pyannote instead:

1. Create a read-capable Hugging Face token at https://huggingface.co/settings/tokens.
2. Accept the conditions for both
   https://huggingface.co/pyannote/speaker-diarization-3.1 and
   https://huggingface.co/pyannote/segmentation-3.0 under that account.
3. A human creates the secret: `modal secret create hf-token HF_TOKEN=...`.
   Never commit the token or send it to the client.
4. After owner approval and merge, a human deploys with the opt-in flag:
   `PODCAST_USE_HF_TOKEN=1 modal deploy -m workers.timeline_tools_worker`.
   Without the flag, deployment has no dependency on an `hf-token` secret and
   uses the fallback. With the flag, the function reads `HF_TOKEN` from that secret;
   unavailable/failed pyannote inference falls back to ECAPA clustering.

Pins are in `workers/podcast-requirements.txt` (torch/torchaudio 2.8.0,
pyannote.audio 3.3.2, SpeechBrain 1.0.3, scikit-learn 1.7.2,
huggingface-hub 0.35.3, av 18.1.0). The diarization image completes all install/env
steps before local source attachment. The normal audio/Studio image stays separate.
Trusted pyannote checkpoints use PyTorch's compatibility loading setting in this
image. Model runtime/download access must be verified by a human after deployment;
unit tests use synthetic turns and mock inference, not paid GPU calls.

Model cards: pyannote 3.1 is MIT and gated; SpeechBrain ECAPA is Apache-2.0.

## Editing, previews and exports

Source recordings and their word timings are immutable. The EDL stores mute,
bleep, ripple delete and insert-silence operations, spelling corrections and global
speaker names. Text selection and timeline blocks share selection; Shift selects
ranges. Disconnected word selections become separate edits. Range cuts and gaps
can target pauses between dialogues. Undo/redo changes the EDL, never the source.

The editor pages transcript words and draws only visible timeline words. Waveform
canvases are bounded even for long recordings. Playback skips deleted ranges,
previews mute/bleep/gaps, seeks video on scrub, and corrects video drift. The source
axis remains visible so removed words can be recovered with undo or edit removal.
Older sessions can be reopened from Recent jobs.

Autosaves use revision checks and serialize requests. A lost reply or revision
conflict requires reloading instead of overwriting another browser's changes.
Exports take an immutable DB snapshot of the saved revision/EDL/transcript. The
worker streams the render in half-second blocks. A 10 ms boundary crossfade at
ripple joins preserves exact EDL length; subtitles remap through cuts/insertions.

First successful export per session is included; later exports charge the edited
output length rounded up to minutes. Database row locks reserve the included export,
validate the confirmed cost and charge atomically only at completion. Failed exports
release the reservation. Free account credits remain one-time and unchanged.
Video export is visibly disabled as **Coming soon**, with no video-render backend.
Speaker merge/split is a later enhancement; names can be changed globally now.

## Migration and verification

A human runs `supabase/migrations/20261024033032_podcast.sql` in the Supabase SQL
Editor after approval/merge. It is idempotent and adds projects/media/transcripts/
edits, owner-only RLS, revision saves, job types and export billing integration.
Existing private uploads/outputs Storage policies cover the new owner-prefixed
objects; no public bucket or broader policy is introduced. No live DDL was run.

Checks: `python -m unittest discover`, `npm test`, `npm run typecheck`,
`npm run build`, and the desk browser suite. Database tests execute all migrations
in PGlite, rerun the Podcast migration, test cross-owner denial and included/paid
export billing. Worker tests cover synthetic diarization assignment, fallback
selection, real ffmpeg video extraction/proxy generation, EDL audio lengths,
bleep/mute levels, subtitle remapping, owner/size checks and billing/error order.

Do not merge or deploy without owner approval.
