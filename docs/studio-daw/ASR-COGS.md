# ASR choice and cost measurement

Model: faster-whisper 1.2.1 **small**, T4 GPU, int8_float16, batch 8, word timestamps,
VAD and forced detected language. CPU int8/batch 2 is the fallback. Models persist
in the existing timeline-tools-asr-models Modal Volume. The GPU image adds pinned
CUDA cuBLAS/cuDNN libraries. Full ASR occurs once per processing job; exports use
stored normalized stems and never rerun ASR.

Language detection is intentionally CPU COGS before billing. Each clip gets only
its first ≤30 seconds of speech (silence trimmed), but 200 clips still have a
nontrivial gate cost. Concurrency, max duration and upload caps remain bounded.

Official references checked 24 October 2026:
- https://github.com/SYSTRAN/faster-whisper/blob/master/README.md
- https://modal.com/docs/guide/gpu
- https://modal.com/docs/guide/volumes
- https://modal.com/pricing (T4 GPU component: $0.000164/second at check time)

**No GPU benchmark was run in this environment.** Do not interpret a fixture or
CPU test as measured T4 COGS. Actual report.json includes the GPU function’s
measured elapsed_seconds, audio_minutes and GPU-only USD/audio-minute when a T4
call succeeds. That figure excludes CPU language gate, CPU/memory during GPU
execution, storage and transfer. Cold model download time is included in elapsed
GPU time. CPU fallback explicitly reports “Not measured”.

Before production approval, process representative 1/10/60-minute Hindi, Telugu,
Tamil and English speech bundles with cold and warm model caches. Record actual
Modal invoice compute seconds (GPU + CPU + memory), storage/transfer, gate wall
time, and source audio minutes. True COGS/audio-minute = all those USD costs /
source audio minutes. Record accuracy separately (matched/missing/unplaced and
manual timing review), including shuffled clips and long silences. Update this
document with measured values after the human-approved migration and worker
deployment. Do not deploy from this PR.

Rendering streams dialogue in half-second blocks rather than creating one delayed
WAV per region. Preview reads five-second PCM byte ranges with an eight-window
cache instead of decoding long stems in full. Arrangement total region material
is bounded to four hours, in addition to duration, region-count and JSON caps.
