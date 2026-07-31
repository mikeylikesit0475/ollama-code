// ─── Custom Ollama LLM Connector ────────────────────────────────────────────
// Bridges ADK's BaseLlm interface to Ollama's OpenAI-compat streaming endpoint.

import { BaseLlm, LlmResponse } from "@google/adk";
import fs from "fs";
import path from "path";
import { createSseParser, ToolCallAccumulator, safeParseToolArguments } from "./sse.ts";
import { c } from "./ui.ts";

// Per-model sampling params for local Ollama models (Ticket 4).
// Replaces the old hardcoded greedy values (top_k:1, top_p:0.1) that amplified
// repetition loops in 12B models. Matches the tuned Modelfile client-side too.
const ollamaModelParams: Record<string, { temperature: number; top_k: number; top_p: number; repeat_penalty: number; repeat_last_n: number; num_predict: number; num_ctx: number }> = {
  // num_ctx MUST match the model's loaded context_length (16384 per `ollama ps`).
  // Sending a different value forces Ollama to reload the model weights (~60s hang per request).
  // num_predict is capped at 8192 so the remaining 8k tokens are available for input context
  // (system prompt + user message + reasoning from prior turns).
  "gemma4-coder-tuned:latest": { temperature: 0.2, top_k: 40, top_p: 0.9, repeat_penalty: 1.15, repeat_last_n: 256, num_predict: 8192, num_ctx: 16384 },
  "gemma4:12b-mlx": { temperature: 0.3, top_k: 40, top_p: 0.9, repeat_penalty: 1.2, repeat_last_n: 512, num_predict: 8192, num_ctx: 16384 },
  "gemma4:12b": { temperature: 0.3, top_k: 40, top_p: 0.9, repeat_penalty: 1.2, repeat_last_n: 512, num_predict: 8192, num_ctx: 16384 },
};
const defaultOllamaParams = { temperature: 0.2, top_k: 40, top_p: 0.9, repeat_penalty: 1.15, repeat_last_n: 256, num_predict: 8192, num_ctx: 16384 };

// If no chunk arrives within this window, the stream is assumed stalled
// (model unloaded, OOM, server hang) and the request is aborted.
const STREAM_INACTIVITY_TIMEOUT_MS = 120_000;

export class OllamaLlm extends BaseLlm {
  private readonly baseUrl: string;
  private readonly onToken?: (delta: string) => void;
  // Last raw API response (for the token-usage footer). An instance field
  // rather than a module global, since cli.ts can hold multiple OllamaLlm
  // instances across a session (e.g. after /model switches models).
  lastResponse: any = null;

  constructor({ model, baseUrl = "http://localhost:11434", onToken }: { model: string; baseUrl?: string; onToken?: (delta: string) => void }) {
    super({ model });
    this.baseUrl = baseUrl;
    this.onToken = onToken;
  }

  async *generateContentAsync(llmRequest: any, stream?: boolean, abortSignal?: AbortSignal): AsyncGenerator<LlmResponse, void> {
    const messages: any[] = [];

    // ADK puts the agent's instruction in llmRequest.config.systemInstruction
    // (NOT in contents). Without this, the CLI's system prompt is never sent
    // to Ollama — the model only sees the Modelfile's baked-in SYSTEM. Forward
    // it as the leading system message so per-model prompts + nudges take effect.
    const si = llmRequest.config?.systemInstruction;
    if (si) {
      let siText = "";
      if (typeof si === "string") {
        siText = si;
      } else if (si.parts && Array.isArray(si.parts)) {
        siText = si.parts.map((p: any) => (typeof p.text === "string" ? p.text : "")).join("\n");
      } else {
        siText = JSON.stringify(si);
      }
      if (siText.trim()) {
        messages.push({ role: "system", content: siText });
      }
    }

    for (const content of llmRequest.contents) {
      const parts = content.parts || [];
      const isToolResponse = parts.some((p: any) => p.functionResponse);

      if (isToolResponse) {
        for (const part of parts) {
          if (part.functionResponse) {
            const fr = part.functionResponse;
            // ADK threads the originating functionCall's id onto the matching
            // functionResponse (see the id we now set below). Keying on that
            // id — rather than on tool name — is what lets two parallel calls
            // to the SAME tool (e.g. two read_file calls) be told apart; a
            // name-only key would cross their results. Name is only a
            // fallback for the (unexpected) case where no id was assigned.
            const toolCallId = fr.id || `call_${fr.name}_noid`;
            messages.push({
              role: "tool",
              tool_call_id: toolCallId,
              name: fr.name,
              content: JSON.stringify(fr.response),
            });
          }
        }
      } else {
        const role = content.role === "model" ? "assistant" : content.role;
        const contentParts = parts.filter((p: any) => p.text);
        const textContent = contentParts.map((p: any) => p.text).join("\n");

        const toolCalls = parts.filter((p: any) => p.functionCall).map((p: any, index: number) => {
          const fc = p.functionCall;
          const toolCallId = fc.id || `call_${fc.name}_${index}_noid`;
          return {
            id: toolCallId,
            type: "function",
            function: {
              name: fc.name,
              arguments: JSON.stringify(fc.args),
            }
          };
        });

        const msg: any = { role };
        msg.content = textContent || "";

        if (toolCalls.length > 0) {
          msg.tool_calls = toolCalls;
        }
        messages.push(msg);
      }
    }

    const tools = llmRequest.config?.tools?.map((t: any) => {
      if (t.functionDeclarations) {
        return t.functionDeclarations.map((fd: any) => ({
          type: "function",
          function: {
            name: fd.name,
            description: fd.description,
            parameters: fd.parameters,
          }
        }));
      }
      return [];
    }).flat();

    // Per-model sampling params (Ticket 4) — replaces the old hardcoded greedy
    // values (top_k:1, top_p:0.1) that amplified repetition loops in 12B models.
    const p = ollamaModelParams[this.model] ?? defaultOllamaParams;
    const temp = llmRequest.config?.temperature ?? p.temperature;

    const requestBody = {
      model: this.model,
      messages,
      tools: tools && tools.length > 0 ? tools : undefined,
      temperature: temp,
      stream: true,
      stream_options: { include_usage: true },
      options: {
        temperature: temp,
        top_k: p.top_k,
        top_p: p.top_p,
        repeat_penalty: p.repeat_penalty,
        repeat_last_n: p.repeat_last_n,
        num_predict: p.num_predict,
        num_ctx: p.num_ctx,
      }
    };

    // Combine ADK's abort signal (Ctrl-C / Esc) with our own inactivity
    // watchdog so a stalled stream fails fast instead of hanging the CLI.
    const internalAbort = new AbortController();
    const onExternalAbort = () => internalAbort.abort();
    if (abortSignal) {
      if (abortSignal.aborted) internalAbort.abort();
      else abortSignal.addEventListener("abort", onExternalAbort, { once: true });
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: internalAbort.signal,
      });
    } catch (err: any) {
      if (abortSignal) abortSignal.removeEventListener("abort", onExternalAbort);
      if (internalAbort.signal.aborted && abortSignal?.aborted) throw err; // user interrupt — propagate as-is
      throw new Error(`Ollama request failed: ${err.message}`);
    }

    if (!response.ok) {
      const errText = await response.text();
      if (abortSignal) abortSignal.removeEventListener("abort", onExternalAbort);
      throw new Error(`Ollama request failed: ${errText}`);
    }

    if (!response.body) {
      if (abortSignal) abortSignal.removeEventListener("abort", onExternalAbort);
      throw new Error("No response body from Ollama streaming endpoint.");
    }

    // SSE parser (Ticket 1): accumulate the final assistant message while
    // streaming text deltas to the terminal via onToken. We still yield exactly
    // ONE complete LlmResponse at the end so ADK receives fully-assembled
    // functionCall parts (yielding partial tool-call fragments would break
    // tool dispatch).
    let assistantText = "";
    let reasoningText = "";
    const accumulator = new ToolCallAccumulator();
    let usage: any = null;
    let modelVersion: string | undefined;
    let streamError: string | null = null;
    let timedOut = false;
    const reader = response.body.getReader();
    const parser = createSseParser();
    const onToken = this.onToken;

    // Inactivity watchdog: if no bytes arrive within the window, abort the
    // fetch (model unloaded, OOM, or server hang).
    let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
    const resetInactivityTimer = () => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        timedOut = true;
        internalAbort.abort();
      }, STREAM_INACTIVITY_TIMEOUT_MS);
    };
    resetInactivityTimer();

    const handleEvent = (event: ReturnType<ReturnType<typeof createSseParser>["push"]>[number]) => {
      if (event.error) { streamError = event.error; return; }
      // gemma4-coder is a thinking model: reasoning arrives separately from
      // content. Capture it for debugging/surfacing but do NOT stream it as
      // visible output (that's the model's private scratchpad).
      if (event.reasoning) reasoningText += event.reasoning;
      if (event.content) {
        assistantText += event.content;
        if (onToken) onToken(event.content);
      }
      if (event.toolCalls.length > 0) accumulator.addAll(event.toolCalls);
      if (event.usage) usage = event.usage;
    };

    try {
      for (;;) {
        let done: boolean;
        let value: Uint8Array | undefined;
        try {
          ({ done, value } = await reader.read());
        } catch (err: any) {
          if (internalAbort.signal.aborted) break; // timeout or user interrupt
          throw err;
        }
        if (done) break;
        resetInactivityTimer();
        for (const event of parser.push(value!)) handleEvent(event);
      }
      // Flush any tail bytes that never got a trailing newline.
      for (const event of parser.flush()) handleEvent(event);
    } finally {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      if (abortSignal) abortSignal.removeEventListener("abort", onExternalAbort);
      // Clean abort: release the connection so the server can free resources.
      try { await reader.cancel(); } catch { /* already closed */ }
      try { reader.releaseLock(); } catch { /* already released */ }
    }

    if (timedOut) {
      throw new Error(`Ollama stream stalled: no data received for ${STREAM_INACTIVITY_TIMEOUT_MS / 1000}s. The model may have been unloaded or the server is hung.`);
    }
    if (streamError) {
      throw new Error(`Ollama stream error: ${streamError}`);
    }

    // Assemble the final assistant message in the SAME shape the old code used,
    // so the existing responseParts -> functionCall mapping still works.
    const assembled = accumulator.complete();
    const message: any = { role: "assistant", content: assistantText || null };
    if (assembled.length > 0) {
      // Ollama's OpenAI-compat stream doesn't always send a tool_call id.
      // Without a stable id, parallel calls to the SAME tool (e.g. two
      // read_file calls) can't be told apart when their results come back —
      // synthesize one here so it survives the round trip through ADK.
      message.tool_calls = assembled.map((tc, index) => ({
        id: tc.id || `call_${tc.function.name}_${index}_${Math.random().toString(36).substring(2, 7)}`,
        type: "function",
        function: { name: tc.function.name, arguments: tc.function.arguments || "{}" },
      }));
    }

    const data: any = { choices: [{ message }], usage, model: modelVersion };
    this.lastResponse = data;

    // Debug dump (gated by OLLAMA_CODE_DEBUG): capture the full request ADK sent
    // (is the system prompt even there? how many tools?) and the full model
    // response (content, reasoning, tool calls) so we can diagnose why the model
    // behaves differently through the CLI vs. plain `ollama run`.
    if (process.env.OLLAMA_CODE_DEBUG) {
      try {
        const home = process.env.HOME || process.cwd();
        const logPath = path.join(home, ".ollama-code", "debug.log");
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        const sysInstrRaw = llmRequest.config?.systemInstruction;
        let sysInstrSummary = "(none in llmRequest.config.systemInstruction)";
        if (sysInstrRaw) {
          const si = typeof sysInstrRaw === "string" ? sysInstrRaw : (sysInstrRaw as any).parts?.map((p: any) => p.text || "").join("\n") || JSON.stringify(sysInstrRaw);
          sysInstrSummary = si.length > 800 ? si.slice(0, 800) + `…(+${si.length - 800} chars)` : si;
        }
        const contentsSummary = (llmRequest.contents || []).map((c: any) => ({
          role: c.role,
          parts: (c.parts || []).map((p: any) => {
            if (p.text) return { text: typeof p.text === "string" ? (p.text.length > 200 ? p.text.slice(0, 200) + `…(+${p.text.length - 200})` : p.text) : "(non-string text)" };
            if (p.functionCall) return { functionCall: p.functionCall.name, args: JSON.stringify(p.functionCall.args).slice(0, 200) };
            if (p.functionResponse) return { functionResponse: p.functionResponse.name };
            return { other: Object.keys(p)[0] || "unknown" };
          }),
        }));
        const entry = {
          time: new Date().toISOString(),
          model: this.model,
          request: {
            contents: contentsSummary,
            systemInstruction: sysInstrSummary,
            toolsCount: (llmRequest.config?.tools || []).length,
            temperature: temp,
          },
          response: {
            contentLength: (message?.content || "").length,
            contentFull: message?.content || "",
            reasoningLength: reasoningText.length,
            reasoningFull: reasoningText,
            toolCalls: (message?.tool_calls || []).map((tc: any) => ({
              name: tc.function.name,
              argsLength: tc.function.arguments.length,
              argsPreview: tc.function.arguments.slice(0, 400),
            })),
          },
        };
        fs.appendFileSync(logPath, JSON.stringify(entry, null, 2) + "\n\n----\n\n");
      } catch {
        // debug logging must never break generation
      }
    }

    const responseParts: any[] = [];
    if (message?.content) {
      responseParts.push({ text: message.content });
    }
    if (message?.tool_calls) {
      responseParts.push(...message.tool_calls.map((tc: any) => {
        // Small models routinely emit malformed JSON args (trailing commas,
        // unclosed braces). Repair what we can; on total failure the sentinel
        // object surfaces a useful error instead of killing the whole turn.
        const { args, repaired, error } = safeParseToolArguments(tc.function.arguments);
        if (repaired) console.error(`  ${c.warn(`[adapter] Repaired malformed tool-call arguments for ${tc.function.name}`)}`);
        if (error) console.error(`  ${c.error(`[adapter] ${error}`)}`);
        return {
          functionCall: {
            id: tc.id,
            name: tc.function.name,
            args,
          }
        };
      }));
    }

    // ADK requires at least one non-empty part (text OR functionCall). If the
    // model emitted ONLY reasoning tokens (thinking-model scratchpad) with no
    // visible content and no tool calls, we surface the reasoning as the text
    // response so ADK doesn't throw "model output must contain either output
    // text or tool calls, these cannot both be empty".
    if (responseParts.length === 0) {
      const fallback = reasoningText.trim() || "(no response)";
      responseParts.push({ text: fallback });
      if (this.onToken) this.onToken(fallback);
    }

    yield {
      content: {
        role: "model",
        parts: responseParts,
      },
      modelVersion: data.model,
    };
  }

  async connect(llmRequest: any): Promise<any> {
    throw new Error("Live connection not supported for Ollama.");
  }
}
