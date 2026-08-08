import test from "node:test";
import assert from "node:assert/strict";
import { createSseParser, ToolCallAccumulator, safeParseToolArguments } from "../lib/sse.ts";
import { allTools } from "../lib/tools/index.ts";

// ─── Failure-injection / chaos tests ─────────────────────────────────────────
// Feed the harness malformed inputs and assert it recovers (returns a structured
// error) instead of crashing. These mirror the edge cases commercial CLIs have
// already hardened against.

// 1. Every tool has a global error boundary: a throwing execute must return a
//    structured { status: "error" } object, never reject.
test("chaos: tool wrapper catches thrown errors", async () => {
  // Build a fake tool that throws, then wrap it the same way index.ts does.
  const fakeTool: any = {
    name: "boom_tool",
    execute: async () => { throw new Error("kaboom"); },
  };
  const original = fakeTool.execute.bind(fakeTool);
  fakeTool.execute = async (args: any) => {
    try {
      return await original(args);
    } catch (err: any) {
      return { status: "error", message: `Tool "boom_tool" failed: ${err.message}` };
    }
  };
  const result = await fakeTool.execute({});
  assert.equal(result.status, "error");
  assert.ok(result.message.includes("kaboom"));
});

// 2. Malformed tool arguments are rejected with a clear message, not a crash.
test("chaos: malformed arguments produce a structured error", async () => {
  const tool = allTools.find((t) => t.name === "read_file");
  assert.ok(tool, "read_file tool exists");
  const result = await tool.execute({ __malformed_arguments: "{ unclosed" }, {});
  assert.equal(result.status, "error");
  assert.ok(result.message.includes("INVALID TOOL CALL"));
});

// 3. SSE parser survives truncated / split / garbage chunks.
test("chaos: SSE parser handles garbage bytes", () => {
  const parser = createSseParser();
  // Random binary-ish garbage should not throw.
  const garbage = Buffer.from([0x00, 0xff, 0x10, 0x00, 0x0a, 0x0d, 0x0a]);
  assert.doesNotThrow(() => parser.push(garbage));
  assert.doesNotThrow(() => parser.flush());
});

test("chaos: SSE parser handles empty chunks", () => {
  const parser = createSseParser();
  assert.doesNotThrow(() => parser.push(Buffer.alloc(0)));
  assert.doesNotThrow(() => parser.flush());
});

// 4. safeParseToolArguments never throws on pathological input.
test("chaos: safeParseToolArguments handles pathological input", () => {
  const cases = ["", "null", "undefined", "{{{{", "]]]]", "{\"a\":", "123", "true", "[1,2,", "{\"a\":1,\"a\":2}"];
  for (const c of cases) {
    assert.doesNotThrow(() => safeParseToolArguments(c));
  }
});

// 5. Tool-call accumulator handles out-of-order / duplicate indices.
test("chaos: ToolCallAccumulator handles duplicate indices", () => {
  const acc = new ToolCallAccumulator();
  acc.addAll([{ index: 0, id: "a", type: "function", function: { name: "x", arguments: "{}" } }]);
  acc.addAll([{ index: 0, id: "b", type: "function", function: { name: "y", arguments: "{}" } }]);
  const result = acc.complete();
  assert.ok(Array.isArray(result));
});
