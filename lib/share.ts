// ─── Session Sharing / Export ─────────────────────────────────────────────────
// Exports a session transcript to a file or a GitHub gist (via the gh CLI).
// The /share command writes a markdown transcript and, optionally, posts it as
// a gist and returns the URL.

import fs from "fs";
import path from "path";
import { execFile } from "child_process";

export interface SessionEvent {
  author?: string;
  content?: any;
}

function stringifyEvent(event: SessionEvent): string {
  const role = event.author === "user" ? "USER" : "AGENT";
  const parts = event.content?.parts || [];
  const text = parts
    .filter((p: any) => p.text)
    .map((p: any) => p.text)
    .join("\n");
  const toolCalls = parts
    .filter((p: any) => p.functionCall)
    .map((p: any) => `[tool: ${p.functionCall.name}]`)
    .join(" ");
  return `${role}: ${text}${toolCalls ? " " + toolCalls : ""}`.trim();
}

// Build a markdown transcript from session events.
export function buildTranscript(events: SessionEvent[]): string {
  const lines = ["# Session Transcript", "", `_Exported ${new Date().toISOString()}_`, ""];
  for (const e of events) {
    const line = stringifyEvent(e);
    if (line) lines.push(line, "");
  }
  return lines.join("\n");
}

// Write the transcript to a local file. Returns the file path.
export function exportToFile(events: SessionEvent[], dir = process.cwd()): string {
  const file = path.join(dir, `session-${Date.now()}.md`);
  fs.writeFileSync(file, buildTranscript(events), "utf-8");
  return file;
}

// Post the transcript as a GitHub gist via the gh CLI. Returns the gist URL.
export async function exportToGist(events: SessionEvent[], description = "ollama-code session"): Promise<string> {
  const transcript = buildTranscript(events);
  const file = path.join(process.cwd(), `.session-${Date.now()}.md`);
  fs.writeFileSync(file, transcript, "utf-8");
  try {
    const url = await new Promise<string>((resolve, reject) => {
      execFile("gh", ["gist", "create", file, "--desc", description], { encoding: "utf-8", timeout: 30000 }, (err, stdout) => {
        if (err) reject(new Error((err as any).stderr || err.message));
        else resolve(stdout.trim());
      });
    });
    return url;
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}
