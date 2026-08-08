// ─── Cost / Usage Tracking (/cost) ────────────────────────────────────────────
// Tracks token usage per session and estimates cost. Local Ollama models are
// free; cloud (Gemini) models use per-1M-token pricing. The CLI records usage
// from each OllamaLlm.lastResponse and accumulates it here.

export interface UsageRecord {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// Approximate per-1M-token pricing (USD). Local models are free.
const CLOUD_PRICES: Record<string, { input: number; output: number }> = {
  "gemini-2.5-flash": { input: 0.30, output: 2.50 },
};

let sessionUsage: UsageRecord = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
let sessionCost = 0;

export function recordUsage(usage: any, model: string): void {
  if (!usage) return;
  const prompt = usage.prompt_tokens || usage.promptTokens || 0;
  const completion = usage.completion_tokens || usage.completionTokens || 0;
  sessionUsage.promptTokens += prompt;
  sessionUsage.completionTokens += completion;
  sessionUsage.totalTokens += prompt + completion;

  const price = CLOUD_PRICES[model];
  if (price) {
    sessionCost += (prompt / 1_000_000) * price.input + (completion / 1_000_000) * price.output;
  }
}

export function resetUsage(): void {
  sessionUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  sessionCost = 0;
}

export function getUsage(): { usage: UsageRecord; cost: number } {
  return { usage: { ...sessionUsage }, cost: sessionCost };
}

export function formatCost(cost: number): string {
  return cost > 0 ? `$${cost.toFixed(4)}` : "free (local model)";
}
