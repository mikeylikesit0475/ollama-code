// ─── Running-Summary Context Compaction ────────────────────────────────────
// Real semantic compaction for local Ollama mode that does NOT collide with the
// OLLAMA_NUM_PARALLEL=1 constraint.
//
// The stock ADK LlmSummarizer fires a SECOND concurrent Ollama request inside
// runner.runAsync, which deadlocks against the main call. TruncatingContextCompactor
// avoids that but is lossy — it just drops the oldest events. This module keeps a
// running summary of the conversation that is refreshed AFTER each turn (when the
// main LLM call has already finished, so a sequential summarizer request is safe)
// and injected into the next turn's prompt. The summary survives truncation, so the
// agent keeps the important facts even after the raw events are dropped.

import { summarizeHistory } from "./summarizer.ts";

interface CompactionState {
  summary: string;
  // Number of turns summarized so far, used to avoid re-summarizing the same
  // history every single turn.
  lastSummarizedTurn: number;
}

const state: CompactionState = {
  summary: "",
  lastSummarizedTurn: 0,
};

export const compaction = {
  getSummary(): string {
    return state.summary;
  },
  reset() {
    state.summary = "";
    state.lastSummarizedTurn = 0;
  },
  // Returns the summary block to inject into the prompt (empty string if none).
  getContextPrompt(): string {
    if (!state.summary) return "";
    return `\n\n---\nPRIOR CONVERSATION SUMMARY (compacted):\n${state.summary}\n---`;
  },
  // Summarize the given history text and store the result. Runs sequentially
  // (after the main turn), so it is safe under OLLAMA_NUM_PARALLEL=1.
  async refresh(model: any, historyText: string, turnNumber: number): Promise<void> {
    if (!historyText.trim()) return;
    // Avoid re-summarizing the exact same history every turn.
    if (turnNumber === state.lastSummarizedTurn) return;
    try {
      const summary = await summarizeHistory(model, historyText);
      if (summary) {
        state.summary = summary;
        state.lastSummarizedTurn = turnNumber;
      }
    } catch (err: any) {
      // Non-fatal: keep the previous summary if summarization fails.
    }
  },
};
