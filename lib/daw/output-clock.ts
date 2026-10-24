/** Project the audio device's presentation clock onto performance.now() time. */
export function outputClockTime(
  context: Pick<AudioContext, "currentTime"> &
    Partial<
      Pick<AudioContext, "getOutputTimestamp" | "baseLatency" | "outputLatency">
    >,
  wallTime = performance.now(),
) {
  const stamp = context.getOutputTimestamp?.();
  const latency = (context.baseLatency ?? 0) + (context.outputLatency ?? 0);
  if (
    stamp &&
    Number.isFinite(stamp.contextTime) &&
    stamp.contextTime! > 0 &&
    Number.isFinite(stamp.performanceTime) &&
    stamp.performanceTime! > 0
  ) {
    const projected =
      stamp.contextTime! + (wallTime - stamp.performanceTime!) / 1000;
    // Reject stale or foreign-time-origin timestamps instead of freezing at zero.
    if (
      projected >= 0 &&
      projected <= context.currentTime + 0.1 &&
      context.currentTime - projected <= Math.max(1, latency + 0.25)
    )
      return projected;
  }
  return Math.max(0, context.currentTime - latency);
}
