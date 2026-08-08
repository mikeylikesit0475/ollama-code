// ─── Repro Mode (--repro) ─────────────────────────────────────────────────────
// Captures the exact request/response that caused a bug and lets you replay it,
// so edge cases become debuggable instead of "it happened once."
//
// When OLLAMA_CODE_REPRO is set (or --repro is passed), every Ollama request is
// written to ~/.ollama-code/repro/<timestamp>.json. The `--repro <file>` flag
// replays a captured request against the model and prints the response, so you
// can reproduce a failure deterministically.

import fs from "fs";
import path from "path";

export interface ReproRecord {
  capturedAt: string;
  model: string;
  request: any;
  response: any;
  error?: string;
}

function reproDir(): string {
  return path.join(process.env.HOME || process.cwd(), ".ollama-code", "repro");
}

export function reproEnabled(): boolean {
  return !!process.env.OLLAMA_CODE_REPRO;
}

// Capture a request/response pair to disk (best-effort).
export function captureRepro(model: string, request: any, response: any, error?: string): void {
  if (!reproEnabled()) return;
  try {
    const dir = reproDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `repro-${Date.now()}.json`);
    const record: ReproRecord = { capturedAt: new Date().toISOString(), model, request, response, error };
    fs.writeFileSync(file, JSON.stringify(record, null, 2), "utf-8");
  } catch {
    // best-effort
  }
}

// Load a captured repro record.
export function loadRepro(file: string): ReproRecord | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

// Replay a captured request against Ollama and print the response.
export async function replayRepro(file: string, baseUrl: string): Promise<string> {
  const record = loadRepro(file);
  if (!record) throw new Error(`Could not load repro file: ${file}`);
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(record.request),
  });
  if (!res.ok) throw new Error(`Replay failed: HTTP ${res.status} ${await res.text()}`);
  const data = await res.json();
  return JSON.stringify(data, null, 2);
}

export function reproDirPath(): string {
  return reproDir();
}
