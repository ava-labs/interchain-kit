/**
 * Poll `read()` until `predicate(value)` is true or `timeoutMs` elapses.
 * Linear backoff (1s, 2s, 3s, ...) capped at 5s. Returns the final value;
 * throws on timeout.
 *
 * Use websocket subscriptions in production — this is for tests and demos.
 */
export async function pollUntil<T>(
  read: () => Promise<T>,
  predicate: (v: T) => boolean,
  opts: { timeoutMs?: number; label?: string } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const label = opts.label ?? "condition";
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < timeoutMs) {
    const value = await read();
    if (predicate(value)) return value;
    attempt += 1;
    const wait = Math.min(5_000, 1_000 * attempt);
    await new Promise((r) => setTimeout(r, wait));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}.`);
}
