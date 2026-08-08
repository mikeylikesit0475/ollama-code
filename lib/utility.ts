// ─── Shared Utility-Agent Runner ────────────────────────────────────────────
// Runs a one-shot LLM agent (no persistent session) for utility tasks like
// planning, summarization, commit-message generation, and sub-agent
// delegation. Each call creates a fresh in-memory session, so utility agents
// never pollute the main conversation history.
//
// IMPORTANT (Ollama constraint): these calls must run SEQUENTIALLY — never
// concurrent with the main agent's generation. Ollama runs with
// OLLAMA_NUM_PARALLEL=1, so a second concurrent request deadlocks against the
// main call. All callers here are invoked either before the main turn
// (planning), after it (summarization), or during tool execution when the main
// LLM call has already completed (delegation) — all safe.

import { LlmAgent, Runner, InMemorySessionService } from "@google/adk";

export interface UtilityAgentOptions {
  onToken?: (token: string) => void;
  tools?: any[];
}

export async function runUtilityAgent(
  model: any,
  systemPrompt: string,
  userPrompt: string,
  opts: UtilityAgentOptions = {}
): Promise<string> {
  const utilityAgent = new LlmAgent({
    name: "utility-agent",
    model,
    instruction: systemPrompt,
    tools: opts.tools ?? [],
  });

  const sessionService = new InMemorySessionService();
  const utilityRunner = new Runner({
    agent: utilityAgent,
    appName: "utility-agent",
    sessionService,
  });

  const tempSessionId = `temp-session-${Math.random().toString(36).substring(2, 9)}`;
  await sessionService.createSession({
    appName: "utility-agent",
    userId: "local-user",
    sessionId: tempSessionId,
  });

  let fullText = "";
  for await (const event of utilityRunner.runAsync({
    userId: "local-user",
    sessionId: tempSessionId,
    newMessage: { role: "user", parts: [{ text: userPrompt }] },
  })) {
    if (event.content && event.content.parts) {
      const text = event.content.parts
        .filter((part: any) => part.text)
        .map((part: any) => part.text)
        .join("");
      if (text) {
        fullText += text;
        if (opts.onToken) opts.onToken(text);
      }
    }
  }
  return fullText;
}
