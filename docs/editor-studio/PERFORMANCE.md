# Timeline rendering (E0)

Main and worker painting share render-core.js. A per-lane augmented interval tree
culls offscreen regions, including long regions crossing the viewport. Exact-source
waveform tiles use multiresolution peaks and a 32 MiB LRU; evicted ImageBitmaps
are closed. Retained waveform and playhead canvases are separate. Pointer geometry
is cached on resize/pointer down. UI clock updates are limited to 10 Hz; the overlay
uses the audio clock at display refresh rate. No drawing changes the saved regions.

The existing 20-track / 500-region / one-hour browser test logs p50, p95 and max;
CI allows 20 ms, local runs retain 16.7 ms. Do not treat historical performance.json
as measurements of this change. Local npm tests (171), typecheck and production
build pass. Browser download is unavailable in this environment, so new browser
performance measurements remain pending CI; no target-device certification is claimed.

No SQL or Modal redeploy is needed for E0.
