const foreignTimeOrigins = new WeakSet<object>();
/** Project the audio device's presentation clock onto performance.now() time. */
export function outputClockTime(
  context: Pick<AudioContext, "currentTime"> &
    Partial<
      Pick<AudioContext, "getOutputTimestamp" | "baseLatency" | "outputLatency">
    >,
  wallTime = performance.now(),
) {
  const stamp = context.getOutputTimestamp?.();
  // A foreign-origin API can later return a plausible projection. Do not switch back to it.
  if (stamp?.performanceTime && stamp.performanceTime > wallTime + 100)
    foreignTimeOrigins.add(context);
  const latency = (context.baseLatency ?? 0) + (context.outputLatency ?? 0);
  if (
    !foreignTimeOrigins.has(context) &&
    stamp &&
    Number.isFinite(stamp.contextTime) &&
    stamp.contextTime! > 0 &&
    Number.isFinite(stamp.performanceTime) &&
    stamp.performanceTime! > 0 &&
    stamp.performanceTime! <= wallTime + 100
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
