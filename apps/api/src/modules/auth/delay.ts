export interface ProgressiveDelayOptions {
  baseDelayMs: number;
  maximumDelayMs: number;
}

export function calculateProgressiveDelayMs(
  attemptCount: number,
  options: ProgressiveDelayOptions,
): number {
  if (attemptCount <= 1) return 0;
  return Math.min(options.maximumDelayMs, options.baseDelayMs * (2 ** (attemptCount - 2)));
}

export function asyncSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
