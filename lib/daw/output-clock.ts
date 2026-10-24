/** Project the audio device's presentation clock onto performance.now() time. */
export function outputClockTime(
  context: Pick<AudioContext, "currentTime"> &
    Partial<
      Pick<AudioContext, "getOutputTimestamp" | "baseLatency" | "outputLatency">
    >,
  wallTime = performance.now(),
) {
  const stamp = context.getOutputTimestamp?.();
  if (
    stamp &&
    Number.isFinite(stamp.contextTime) &&
    stamp.contextTime! > 0 &&
    Number.isFinite(stamp.performanceTime) &&
    stamp.performanceTime! > 0
  )
    return Math.max(
      0,
      stamp.contextTime! + (wallTime - stamp.performanceTime!) / 1000,
    );
  return Math.max(
    0,
    context.currentTime -
      (context.baseLatency ?? 0) -
      (context.outputLatency ?? 0),
  );
}
