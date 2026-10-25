# Validation — 25 October 2026

Base: `6e6135876265f345753285d35e9381ae1b7adcf1`.

| Check | Result |
| --- | --- |
| Production `next build` (including TypeScript) | Passed |
| `npm test` | 200 passed |
| `python -m unittest discover -s workers/tests -v` | 57 run, passed, 1 skipped |
| Desk/browser regression suite excluding the existing video timing case | 25 passed (85 seconds) |
| Editor layout | Timeline at least 65% of viewport height at both 1440×900 and 1280×800; no document scrolling; drawers initially closed |
| Persistence | Owner-only inline rename; foreign/suspended users blocked; arrangement edits retain the revision RPC; insert ordering, bypass and parameters survive reload |
| Audio | Actual WAV exports differ with enabled effects; native EQ/Space/Echo/Warmth compared against streamed Python DSP; actual Python export includes effects and reverse |

## Environment and performance interpretation

Local browser checks use portable Chromium 153 on shared Linux, because the normal Playwright browser CDN download was unavailable. This is not certification for physical desktop Safari, Firefox, M1 or i5 hardware. The existing Firefox/WebKit workflow now includes the new DAW suite and installs scipy for parity tests. Its native browser results must be reviewed before marking ready.

The 16-track × 50-clip test scrolls vertically and horizontally and changes zoom over 240 refreshes, discarding 60 warm-up frames. It reports raw timing and checks the 16.7 ms frame budget by counting 60 Hz refresh intervals: privacy rounding can make one 16.667 ms interval read 16.8 ms. A p95 of two refresh intervals fails. More than 5% missed refreshes also fails. Final 16-track/800-clip raw timings: p50 **16.7 ms**, p95 **16.7 ms**, maximum **16.8 ms** (one refresh interval after timestamp quantization). The existing 20-track/500-region desk budget remains unchanged (16.7 ms locally / 20 ms in CI). Performance is measured without the worker test suite running concurrently.

## Existing video timing failure reproduced on the base commit

The unchanged Podcast video test measured decoded-frame p95 **72.912 ms** on `6e61358`, exceeding its **66.667 ms** budget in this portable browser. The feature branch measured **73.642 ms** in the matching early run. This test was then excluded from the final functional regression pass; its assertions, synchronization implementation and CI budgets were not weakened. Firefox/WebKit and the standard CI Chromium build still need to establish their own result.

## Operations

Apply `20261025041003_editor_project_rename.sql`, deploy the web build and redeploy the existing Modal worker after review. No production migration, worker deployment or merge was performed during implementation. See README for effect approximations and local-export warm-up limits.

## Firefox DSP and WebKit rendering follow-up

Verified with Playwright 1.64.1, Firefox 157, WebKit 27.2 and Chromium headless shell 156.0.8078.4 in the local Linux container. Browser audio used a 48 kHz PulseAudio null sink. Firefox required its content/RDD/GMP sandbox environment overrides in this container; repository launch settings were not changed.

- Production build and TypeScript checks passed; Node tests: 203 passed. Python worker suite: 56 passed, one existing skip.
- Full desk suite: **26 passed**, including the existing 20-track/500-clip budget (p95 16.7 ms) and the 16-track/800-clip scroll/zoom budget (p95 16.7 ms).
- Full Firefox + WebKit suite: **21 passed, two existing Chromium-only skips, one failure**. Both requested regressions passed in both engines. Firefox effect maximum difference was `1.4901161193847656e-7`; WebKit was `0.0009039109572768211`, against the unchanged `< 0.005` assertion.
- WebKit raw rAF p95 was 24 ms in the full run; the existing refresh-normalized frame budget and missed-refresh assertions passed. Neither performance assertion, the DSP tolerance, nor browser coverage was relaxed.
- Remaining failure: WebKit's existing `Podcast fork preview follows paused seeks, live jumps and inserted silence` timing test. It also failed against the unchanged branch tree (`0aa3a43`) in this environment (clock p95 0.1637 s against 0.1333 s). Firefox's video test passed once the local decoder sandbox configuration was corrected. This follow-up does not claim an entirely green native browser suite.

Echo now uses an AudioWorklet with the Python export renderer's sample recurrence, rather than relying on engine-specific feedback-cycle scheduling. Audio-only Editor rendering retains shared clip bitmaps at eight zoom levels per octave, pools image elements, culls off-screen rows/clips, and applies exact scroll/zoom transforms through one rAF scheduler. Wheel zoom and ordinary scrolling do not rerender the React track controls. Regression tests cover the delay's stereo/block state, bitmap reuse, bounded visible image creation and clip-relative waveform cache keys.
