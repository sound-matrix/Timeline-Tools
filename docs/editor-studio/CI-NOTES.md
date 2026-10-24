# PR #16 CI fixes

## Deterministic npm failure reproduction

On the pre-fix checkout (local 7769dc9 / remote acc0a980), run the two parity test
files with a non-project working directory and unrelated PYTHONPATH. Exactly
three tests fail with `ModuleNotFoundError: No module named workers`:

- client and Python apply the identical fixture, including omitted values
- Podcast defaults preserve strictness and mirror Python
- EDL unions overlapping cuts, remaps subtitle endpoints and insertion gaps identically to Python

The saved npm-cwd-before.txt and npm-cwd-after.txt contain the full outputs.
The baseline copies only change the test filenames, preserving their original
relative JavaScript imports. Both runs use the same Python, Node and environment.
Before: 17/20 pass, 3 fail. After: 20/20 pass. This demonstrates a three-failure
mode; without the user's original failure log it cannot prove historical identity.

The tests now use tests/support/python.mjs, resolving the checkout from its module
URL, setting cwd/PYTHONPATH explicitly, and reporting interpreter, exit status,
signal and stderr on failure. The check job explicitly selects Python 3.12.
There is no retry or failure suppression.

Two additional dependencies were removed: playback tests await initial source
scheduling instead of a zero-delay timer; the billing test deliberately reverses
queue timestamps and uses returned claim IDs rather than assuming FIFO order.
The latter now tests the same balance race with either claimed job identity.

Baseline stress: five runs x 184 tests pass. Revised stress: three serial and
three parallel runs x 185 tests pass. Full suite after Python isolation: 185 pass.

## Browser fixes

Release automation uses a separate gain node from the immutable fade curve.
This avoids Firefox rejecting automation during an active curve. CI run
40106787163 passed Firefox's complete scenario, with decoded-frame p95 30.7 ms.
Editor video-strip props are memoized, avoiding thumbnail restarts at 10 Hz.
Small preview drift adjusts native playback rate instead of seeking every frame;
rate updates are quantized and throttled. The preview is explicitly muted.
The existing thumbnail memory/IndexedDB cache remains bounded and reused.
Native video is used directly; no per-frame JavaScript video decode is introduced.
The presentation-clock follow-up uses AudioContext.getOutputTimestamp to project
the device clock onto performance time. Scheduling still uses currentTime.
Video waits until the initial audio sample reaches the device; the benchmark
compares against requestVideoFrameCallback.expectedDisplayTime. This distinguishes
render-ahead buffering from actual A/V alignment. The 66.7 ms assertion is retained.
Reference: https://www.w3.org/TR/webaudio-1.1/#dom-audiocontext-getoutputtimestamp
Two deterministic output-clock tests bring the local suite to 187 passing tests.
WebKit budget verification is still in progress. No relaxed budget is claimed yet.

## Merge dependency

PR #15 was still open/draft when this investigation started. PR #16 must be
rebased onto main after #15 merges, rechecked, then marked ready. A scoped GitHub
merge-event automation is registered for that work; it must keep draft if any
requested validation gate fails. Neither PR is merged by this task.
