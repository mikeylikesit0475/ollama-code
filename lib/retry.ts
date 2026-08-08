// ─── Retry with Backoff ───────────────────────────────────────────────────────
// Wraps flaky external calls (Ollama, MCP, LSP, gh, network) with retry +
// exponential backoff + jitter. Transient failures (network drops, 5xx, timeouts)
// are retried; deterministic errors (4xx, validation) fail fast.

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  // Return true to retry on this error, false to fail fast.
  shouldRetry?: (err: any) => boolean;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  baseDelayMs: 200,
  maxDelayMs: 2000,
  shouldRetry: (err: any) => {
    const status = err?.status ?? err?.code;
    // Retry on network errors, timeouts, and 5xx. Fail fast on 4xx.
    if (typeof status === "number") return status >= 500;
    if (err?.name === "AbortError" || err?.code === "ETIMEDOUT" || err?.code === "ECONNRESET") return true;
    return true; // default: retry unknown errors
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const o = { ...DEFAULT_OPTIONS, ...opts };
  let lastErr: any;
  for (let attempt = 0; attempt <= o.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      if (attempt >= o.maxRetries || !o.shouldRetry(err)) throw err;
      // Exponential backoff with jitter.
      const delay = Math.min(o.maxDelayMs, o.baseDelayMs * Math.pow(2, attempt));
      const jitter = Math.random() * delay * 0.3;
      await sleep(delay + jitter);
    }
  }
  throw lastErr;
}
