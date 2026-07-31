// ─── SSE Stream Parsing & Tool-Call Accumulation ────────────────────────────
// Extracted from OllamaLlm so the wire protocol is testable in isolation.
// Handles the OpenAI-compatible /v1/chat/completions streaming format:
//   - "data: {...}\n\n" events, possibly split across arbitrary byte chunks
//   - incremental tool_calls deltas accumulated by index
//   - reasoning-only chunks (thinking models) surfaced separately
//   - in-stream {"error": ...} payloads from Ollama
//   - CRLF line endings and a final event with no trailing newline

export interface SseToolCall {
  id?: string;
  type?: string;
  index?: number;
  function: { name: string; arguments: string };
}

export interface SseEvent {
  content: string;
  reasoning: string;
  toolCalls: SseToolCall[];
  finishReason: string | null;
  usage: any | null;
  error: string | null;
}

export interface SseParser {
  /** Feed raw bytes from the stream. Returns completed events. */
  push(chunk: Uint8Array): SseEvent[];
  /** Flush remaining buffered bytes at end-of-stream. Returns final events. */
  flush(): SseEvent[];
}

export function createSseParser(): SseParser {
  const decoder = new TextDecoder();
  let buffer = "";

  function parseLine(line: string): SseEvent | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return null;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") return null;

    let chunk: any;
    try {
      chunk = JSON.parse(payload);
    } catch {
      return null; // unparseable keep-alive / partial payload — skip
    }

    // Ollama can emit an error object mid-stream (OOM, model unload, etc.)
    if (chunk.error) {
      const message = typeof chunk.error === "string" ? chunk.error : chunk.error.message || JSON.stringify(chunk.error);
      return { content: "", reasoning: "", toolCalls: [], finishReason: null, usage: null, error: message };
    }

    const choice = chunk.choices?.[0];
    const delta = choice?.delta ?? {};
    const toolCalls: SseToolCall[] = (delta.tool_calls ?? []).map((tc: any) => ({
      id: tc.id,
      type: tc.type,
      index: tc.index,
      function: {
        name: tc.function?.name ?? "",
        arguments: tc.function?.arguments ?? "",
      },
    }));

    return {
      content: delta.content ?? "",
      reasoning: delta.reasoning ?? "",
      toolCalls,
      finishReason: choice?.finish_reason ?? null,
      usage: chunk.usage ?? null,
      error: null,
    };
  }

  return {
    push(chunk: Uint8Array): SseEvent[] {
      buffer += decoder.decode(chunk, { stream: true });
      const events: SseEvent[] = [];
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // last element is an incomplete line
      for (const line of lines) {
        const event = parseLine(line);
        if (event) events.push(event);
      }
      return events;
    },
    flush(): SseEvent[] {
      // Flush the decoder's internal state, then parse any tail bytes that
      // never got a trailing newline.
      buffer += decoder.decode();
      const events: SseEvent[] = [];
      if (buffer.trim()) {
        const event = parseLine(buffer);
        if (event) events.push(event);
      }
      buffer = "";
      return events;
    },
  };
}

// Accumulates incremental tool_calls deltas (keyed by index, per the
// OpenAI-compat spec) into complete tool calls.
export class ToolCallAccumulator {
  private map = new Map<number, SseToolCall>();

  addAll(calls: SseToolCall[]): void {
    calls.forEach((tc, i) => {
      // The wire format keys deltas by an explicit `index` field; fall back
      // to array position when the server omits it.
      const idx = tc.index ?? i;
      const existing = this.map.get(idx);
      if (existing) {
        if (tc.id) existing.id = tc.id;
        if (tc.function.name) existing.function.name = tc.function.name; // sent once; assign, don't append
        existing.function.arguments += tc.function.arguments;
      } else {
        this.map.set(idx, {
          id: tc.id,
          type: tc.type,
          function: { name: tc.function.name, arguments: tc.function.arguments },
        });
      }
    });
  }

  complete(): SseToolCall[] {
    return [...this.map.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, tc]) => tc);
  }

  get size(): number {
    return this.map.size;
  }
}

// Small models routinely emit malformed JSON in tool arguments: trailing
// commas, raw newlines inside strings, unbalanced braces. Repair what we can;
// on total failure return a sentinel object carrying the raw text so the tool
// call surfaces a useful error instead of killing the whole turn.
export function safeParseToolArguments(raw: string): { args: any; repaired: boolean; error?: string } {
  try {
    return { args: JSON.parse(raw), repaired: false };
  } catch {
    // fall through to repair
  }

  // Repair pass 1: trailing commas + literal newlines between tokens.
  let candidate = raw
    .trim()
    .replace(/,\s*([\]}])/g, "$1")
    .replace(/\n/g, " ");
  try {
    return { args: JSON.parse(candidate), repaired: true };
  } catch {
    // fall through
  }

  // Repair pass 2: balance unclosed braces/brackets (model got cut off).
  const openBraces = (candidate.match(/{/g) || []).length - (candidate.match(/}/g) || []).length;
  const openBrackets = (candidate.match(/\[/g) || []).length - (candidate.match(/]/g) || []).length;
  if (openBraces > 0 || openBrackets > 0) {
    candidate += "]".repeat(Math.max(0, openBrackets)) + "}".repeat(Math.max(0, openBraces));
    try {
      return { args: JSON.parse(candidate), repaired: true };
    } catch {
      // fall through
    }
  }

  return {
    args: { __malformed_arguments: raw },
    repaired: false,
    error: `Model emitted malformed tool-call arguments that could not be repaired: ${raw.slice(0, 200)}`,
  };
}
