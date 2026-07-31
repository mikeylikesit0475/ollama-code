import { test } from "node:test";
import assert from "node:assert/strict";
import { createSseParser, ToolCallAccumulator, safeParseToolArguments } from "../lib/sse.ts";

const enc = new TextEncoder();

function sseLines(...payloads: string[]): Uint8Array {
  return enc.encode(payloads.map(p => `data: ${p}\n\n`).join(""));
}

test("parses a simple content chunk", () => {
  const parser = createSseParser();
  const events = parser.push(sseLines(JSON.stringify({
    choices: [{ delta: { content: "hello" }, finish_reason: null }],
  })));
  assert.equal(events.length, 1);
  assert.equal(events[0].content, "hello");
  assert.equal(events[0].error, null);
});

test("handles JSON split across byte chunks", () => {
  const parser = createSseParser();
  const full = `data: {"choices":[{"delta":{"content":"split me"},"finish_reason":null}]}\n\n`;
  const bytes = enc.encode(full);
  const mid = Math.floor(bytes.length / 2);
  const e1 = parser.push(bytes.slice(0, mid));
  const e2 = parser.push(bytes.slice(mid));
  assert.equal(e1.length, 0);
  assert.equal(e2.length, 1);
  assert.equal(e2[0].content, "split me");
});

test("handles CRLF line endings", () => {
  const parser = createSseParser();
  const events = parser.push(enc.encode(
    `data: {"choices":[{"delta":{"content":"crlf"},"finish_reason":null}]}\r\n\r\n`
  ));
  assert.equal(events.length, 1);
  assert.equal(events[0].content, "crlf");
});

test("flushes a final event with no trailing newline", () => {
  const parser = createSseParser();
  parser.push(enc.encode(`data: {"choices":[{"delta":{"content":"tail"},"finish_reason":"stop"}]}`));
  const events = parser.flush();
  assert.equal(events.length, 1);
  assert.equal(events[0].content, "tail");
  assert.equal(events[0].finishReason, "stop");
});

test("surfaces in-stream error payloads", () => {
  const parser = createSseParser();
  const events = parser.push(sseLines(JSON.stringify({ error: "model requires more system memory" })));
  assert.equal(events.length, 1);
  assert.equal(events[0].error, "model requires more system memory");
});

test("captures reasoning separately from content", () => {
  const parser = createSseParser();
  const events = parser.push(sseLines(JSON.stringify({
    choices: [{ delta: { reasoning: "thinking...", content: "" }, finish_reason: null }],
  })));
  assert.equal(events[0].reasoning, "thinking...");
  assert.equal(events[0].content, "");
});

test("ignores [DONE] and keep-alive lines", () => {
  const parser = createSseParser();
  const events = parser.push(enc.encode(`data: [DONE]\n\n: keep-alive\n\n`));
  assert.equal(events.length, 0);
});

test("captures usage from the final chunk", () => {
  const parser = createSseParser();
  const events = parser.push(sseLines(JSON.stringify({
    choices: [{ delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  })));
  assert.equal(events[0].usage.total_tokens, 15);
});

test("accumulates incremental tool_calls by index", () => {
  const acc = new ToolCallAccumulator();
  acc.addAll([{ id: "call_1", type: "function", index: 0, function: { name: "read_file", arguments: '{"pa' } }]);
  acc.addAll([{ function: { name: "", arguments: 'th": "x.ts"}' } }]);
  const complete = acc.complete();
  assert.equal(complete.length, 1);
  assert.equal(complete[0].function.name, "read_file");
  assert.equal(complete[0].function.arguments, '{"path": "x.ts"}');
});

test("keeps parallel same-name tool calls separate", () => {
  const acc = new ToolCallAccumulator();
  acc.addAll([
    { id: "call_1", type: "function", index: 0, function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
    { id: "call_2", type: "function", index: 1, function: { name: "read_file", arguments: '{"path":"b.ts"}' } },
  ]);
  const complete = acc.complete();
  assert.equal(complete.length, 2);
  assert.equal(complete[0].id, "call_1");
  assert.equal(complete[1].id, "call_2");
});

test("safeParseToolArguments parses clean JSON", () => {
  const { args, repaired } = safeParseToolArguments('{"path": "x.ts"}');
  assert.deepEqual(args, { path: "x.ts" });
  assert.equal(repaired, false);
});

test("safeParseToolArguments repairs trailing commas", () => {
  const { args, repaired } = safeParseToolArguments('{"path": "x.ts",}');
  assert.deepEqual(args, { path: "x.ts" });
  assert.equal(repaired, true);
});

test("safeParseToolArguments balances unclosed braces", () => {
  const { args, repaired } = safeParseToolArguments('{"path": "x.ts"');
  assert.deepEqual(args, { path: "x.ts" });
  assert.equal(repaired, true);
});

test("safeParseToolArguments returns sentinel on total failure", () => {
  const { args, error } = safeParseToolArguments('not json at all {{{');
  assert.ok(args.__malformed_arguments);
  assert.ok(error);
});
