/**
 * Calculates exponential backoff with full jitter according to AGENTS.md §2 & PRD FR6.
 * backoff(attempts) = min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2^attempts) + random(0, backoff * 0.2)
 *
 * @param attempts Current number of failed execution attempts
 * @returns Backoff delay in milliseconds
 */
export function calculateBackoffMs(attempts: number): number {
  if (!process.env.BACKOFF_BASE_MS) {
    throw new Error("BACKOFF_BASE_MS environment variable is not defined");
  }
  if (!process.env.BACKOFF_CAP_MS) {
    throw new Error("BACKOFF_CAP_MS environment variable is not defined");
  }
  const baseMs = parseInt(process.env.BACKOFF_BASE_MS, 10);
  const capMs = parseInt(process.env.BACKOFF_CAP_MS, 10);

  // min(capMs, baseMs * 2^attempts)
  const exponentialDelay = Math.min(capMs, baseMs * Math.pow(2, attempts));

  // Jitter up to 20%
  const jitter = Math.random() * (exponentialDelay * 0.2);

  return Math.floor(exponentialDelay + jitter);
}
