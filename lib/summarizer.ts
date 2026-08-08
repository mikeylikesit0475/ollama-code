// ─── Context Summarizer ─────────────────────────────────────────────────────
// A proper summarization-based context compactor for local Ollama mode.
//
// The stock ADK LlmSummarizer fires a SECOND concurrent Ollama request inside
// runner.runAsync, which deadlocks against the main call (OLLAMA_NUM_PARALLEL=1).
// Instead of fighting that, we run summarization OUTSIDE the main runner: the
// main loop detects when the session history has grown large, calls
// summarizeHistory() (a sequential utility-agent call, safe because the main
// LLM call has already finished by then), and replaces the oldest turns with a
// compact summary before the next turn. This gives real semantic compaction
// instead of the lossy truncation of TruncatingContextCompactor.

import { runUtilityAgent } from "./utility.ts";

const SUMMARIZER_SYSTEM_PROMPT = `You are a conversation summarizer for a coding agent. You will be given a block of prior conversation history (user requests, agent reasoning, tool calls, and results).

Produce a dense, factual summary that preserves:
1. The user's goals and any explicit requirements/constraints.
2. What files were created/modified and what was changed in them.
3. Any decisions made, dead-ends hit, and the current state of the work.
4. Anything the agent still needs to remember to continue correctly.

Write in third person, past tense. Be concise but complete — the summary will replace the original history, so it must carry forward everything important. Do NOT address the user, ask questions, or propose next steps. Output ONLY the summary text.`;

export async function summarizeHistory(
  model: any,
  historyText: string
): Promise<string> {
  const summary = (await runUtilityAgent(model, SUMMARIZER_SYSTEM_PROMPT, historyText)).trim();
  return summary || "";
}
