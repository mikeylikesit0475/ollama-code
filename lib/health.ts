// ─── Environment Health Check (/doctor) ───────────────────────────────────────
// Surfaces the state of every integration point: Ollama reachability, model
// availability, bwrap, gh auth, MCP servers, LSP servers, git, and the config
// file. Returns a list of { ok, label, detail } checks.

import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { isBwrapAvailable } from "./sandbox.ts";
import { listMcpServers } from "./mcp.ts";
import { listLspServers } from "./lsp.ts";
import { loadConfig } from "./config.ts";

export interface HealthCheck {
  ok: boolean;
  label: string;
  detail: string;
}

function run(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf-8", timeout: 8000 }, (err, stdout) => {
      resolve({ code: err ? 1 : 0, out: (stdout || "").trim() });
    });
  });
}

export async function runHealthChecks(baseUrl: string): Promise<HealthCheck[]> {
  const checks: HealthCheck[] = [];

  // Ollama server reachable?
  try {
    const res = await fetch(`${baseUrl}/api/tags`);
    const data: any = await res.json();
    const models = (data?.models || []).map((m: any) => m.name);
    checks.push({
      ok: res.ok,
      label: "Ollama server",
      detail: res.ok ? `${baseUrl} (${models.length} model(s))` : `HTTP ${res.status}`,
    });
  } catch (e: any) {
    checks.push({ ok: false, label: "Ollama server", detail: `unreachable: ${e.message}` });
  }

  // Git repo?
  const git = await run("git", ["rev-parse", "--is-inside-work-tree"]);
  checks.push({ ok: git.code === 0, label: "Git repository", detail: git.code === 0 ? "yes" : "not a git repo" });

  // bwrap (sandbox)?
  checks.push({ ok: isBwrapAvailable(), label: "bwrap (sandbox)", detail: isBwrapAvailable() ? "available" : "not installed" });

  // gh CLI?
  const gh = await run("gh", ["--version"]);
  checks.push({ ok: gh.code === 0, label: "gh CLI", detail: gh.code === 0 ? gh.out.split("\n")[0] : "not installed" });

  // gh auth?
  if (gh.code === 0) {
    const auth = await run("gh", ["auth", "status"]);
    checks.push({ ok: auth.code === 0, label: "gh auth", detail: auth.code === 0 ? "authenticated" : "not authenticated" });
  }

  // MCP servers configured?
  const mcp = listMcpServers();
  checks.push({ ok: true, label: "MCP servers", detail: mcp.length ? mcp.join(", ") : "none configured" });

  // LSP servers configured?
  const lsp = listLspServers();
  checks.push({ ok: true, label: "LSP servers", detail: lsp.length ? lsp.join(", ") : "none configured" });

  // Config file present?
  const cfg = loadConfig();
  const cfgPath = path.join(process.cwd(), ".ollama-code.json");
  checks.push({
    ok: fs.existsSync(cfgPath),
    label: "Config file",
    detail: fs.existsSync(cfgPath) ? cfgPath : "none (using defaults)",
  });

  return checks;
}
