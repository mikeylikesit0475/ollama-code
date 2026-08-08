import { test } from "node:test";
import assert from "node:assert/strict";
import { OllamaLlm } from "../lib/ollama-llm.ts";

// Stub global fetch so refreshContextWindow() never touches the network.
// Each test sets the resolved /api/show payload before calling.
function stubFetch(payload: unknown, ok = true) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok,
    json: async () => payload,
  })) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test("refreshContextWindow resolves native context when no num_ctx is pinned", async () => {
  const restore = stubFetch({ model_info: { "llama.context_length": 8192 } });
  try {
    const llm = new OllamaLlm({ model: "some-untuned-model" });
    assert.equal(llm.getContextWindow(), 8192); // fallback before refresh
    const resolved = await llm.refreshContextWindow();
    assert.equal(resolved, 8192);
    assert.equal(llm.getContextWindow(), 8192);
  } finally {
    restore();
  }
});

test("refreshContextWindow caps the window at the pinned num_ctx", async () => {
  // gemma4-coder-tuned pins num_ctx: 16384; native is larger, so effective = 16384.
  const restore = stubFetch({ model_info: { "llama.context_length": 32768 } });
  try {
    const llm = new OllamaLlm({ model: "gemma4-coder-tuned:latest" });
    const resolved = await llm.refreshContextWindow();
    assert.equal(resolved, 16384);
    assert.equal(llm.getContextWindow(), 16384);
  } finally {
    restore();
  }
});

test("refreshContextWindow uses native length when it is smaller than num_ctx", async () => {
  // A 4k Modelfile would report 100%+ against an 8192 fallback; the resolved
  // window must reflect the real (smaller) native length.
  const restore = stubFetch({ model_info: { "llama.context_length": 4096 } });
  try {
    const llm = new OllamaLlm({ model: "gemma4-coder-tuned:latest" });
    const resolved = await llm.refreshContextWindow();
    assert.equal(resolved, 4096);
    assert.equal(llm.getContextWindow(), 4096);
  } finally {
    restore();
  }
});

test("refreshContextWindow falls back to the previous guess on API failure", async () => {
  const restore = stubFetch({}, false); // HTTP error
  try {
    const llm = new OllamaLlm({ model: "gemma4-coder-tuned:latest" });
    const resolved = await llm.refreshContextWindow();
    assert.equal(resolved, 16384); // pinned num_ctx fallback
    assert.equal(llm.getContextWindow(), 16384);
  } finally {
    restore();
  }
});

test("refreshContextWindow falls back to default when model is unknown and API fails", async () => {
  const restore = stubFetch({}, false);
  try {
    const llm = new OllamaLlm({ model: "unknown-model" });
    const resolved = await llm.refreshContextWindow();
    assert.equal(resolved, 8192); // conservative default
  } finally {
    restore();
  }
});
