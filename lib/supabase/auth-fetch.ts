export const SUPABASE_AUTH_TIMEOUT_MS = 10_000;

export class SupabaseAuthTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Supabase Auth request timed out after ${timeoutMs}ms`);
    this.name = "SupabaseAuthTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export function createSupabaseAuthFetch(
  baseFetch: typeof fetch = fetch,
  timeoutMs = SUPABASE_AUTH_TIMEOUT_MS,
): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new SupabaseAuthTimeoutError(timeoutMs)), timeoutMs);

    try {
      // Auth requests must not inherit an already-aborted runtime signal. This
      // server-only client owns a bounded 10-second network lifetime instead.
      return await baseFetch(input, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw new SupabaseAuthTimeoutError(timeoutMs);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
}
