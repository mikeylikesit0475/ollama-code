import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { postWriteVerify } from "../lib/verify.ts";
import { scratchpad } from "../lib/scratchpad.ts";

test("verify: invalid JSON produces error notice", async () => {
  const tmpJson = path.join(process.cwd(), "target", "test-invalid.json");
  fs.mkdirSync(path.dirname(tmpJson), { recursive: true });
  fs.writeFileSync(tmpJson, "{ unclosed json", "utf-8");

  try {
    const result = await postWriteVerify(tmpJson, process.cwd());
    assert.ok(result !== null);
    assert.ok(result.includes("JSON syntax error"));
  } finally {
    if (fs.existsSync(tmpJson)) fs.unlinkSync(tmpJson);
  }
});

test("verify: valid JSON returns null", async () => {
  const tmpJson = path.join(process.cwd(), "target", "test-valid.json");
  fs.mkdirSync(path.dirname(tmpJson), { recursive: true });
  fs.writeFileSync(tmpJson, JSON.stringify({ ok: true }), "utf-8");

  try {
    const result = await postWriteVerify(tmpJson, process.cwd());
    assert.equal(result, null);
  } finally {
    if (fs.existsSync(tmpJson)) fs.unlinkSync(tmpJson);
  }
});

test("scratchpad: tracks file changes and errors", () => {
  scratchpad.reset();
  scratchpad.recordFileChange("src/App.tsx");
  scratchpad.recordError("src/App.tsx", "SyntaxError: Unexpected token");

  const prompt = scratchpad.getContextPrompt();
  assert.ok(prompt.includes("Modified Files This Session"));
  assert.ok(prompt.includes("src/App.tsx"));
  assert.ok(prompt.includes("Active Unresolved Errors"));

  scratchpad.clearError("src/App.tsx");
  const promptCleared = scratchpad.getContextPrompt();
  assert.ok(!promptCleared.includes("Active Unresolved Errors"));
  scratchpad.reset();
});
