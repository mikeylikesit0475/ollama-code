// ─── LSP Integration ─────────────────────────────────────────────────────────
// A lightweight Language Server Protocol client that provides real-time
// diagnostics and go-to-definition for the active file. This is the "IDE
// intelligence" layer that verify.ts (syntax-only) can't provide.
//
// Servers are configured in the config file:
//   {
//     "lsp": {
//       "typescript": { "command": "typescript-language-server", "args": ["--stdio"] },
//       "python":     { "command": "pyright-langserver", "args": ["--stdio"] }
//     }
//   }
//
// The client speaks JSON-RPC over stdio. It lazily starts a server for a file's
// language, sends didOpen, and collects publishDiagnostics. go-to-definition
// returns the target file/line.

import { spawn, ChildProcess } from "child_process";
import fs from "fs";
import path from "path";

interface LspServerConfig {
  command: string;
  args?: string[];
}

interface Diagnostic {
  file: string;
  line: number;
  message: string;
  severity: string;
}

interface Definition {
  file: string;
  line: number;
  character: number;
}

const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".js": "typescript", ".jsx": "typescript",
  ".py": "python", ".go": "go", ".rs": "rust", ".java": "java", ".c": "c", ".cpp": "cpp",
};

function loadLspConfig(): Record<string, LspServerConfig> {
  const candidates = [
    path.join(process.cwd(), ".ollama-code.json"),
    path.join(process.env.HOME || process.cwd(), ".ollama-code", "config.json"),
  ];
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
        const lsp = raw?.lsp;
        if (lsp && typeof lsp === "object") return lsp;
      }
    } catch {
      // ignore
    }
  }
  return {};
}

class LspClient {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private diagnostics: Diagnostic[] = [];
  private buffer = "";
  private rootUri: string;

  constructor(private lang: string, private cfg: LspServerConfig) {
    this.rootUri = "file://" + process.cwd();
  }

  private start(): void {
    if (this.proc) return;
    this.proc = spawn(this.cfg.command, this.cfg.args || [], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout!.on("data", (d: Buffer) => this.onData(d.toString()));
    this.proc.stderr!.on("data", (d: Buffer) => {
      // LSP servers log to stderr; ignore unless it's a crash.
    });
    this.proc.on("exit", () => { this.proc = null; });
    this.send("initialize", {
      processId: process.pid,
      rootUri: this.rootUri,
      capabilities: { textDocument: { definition: { linkSupport: true } } },
    }).then(() => this.send("initialized", {}));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    // Parse Content-Length framed messages.
    let idx;
    while ((idx = this.buffer.indexOf("\r\n\r\n")) !== -1) {
      const header = this.buffer.slice(0, idx);
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) { this.buffer = this.buffer.slice(idx + 4); continue; }
      const len = parseInt(m[1], 10);
      const bodyStart = idx + 4;
      if (this.buffer.length < bodyStart + len) break;
      const body = this.buffer.slice(bodyStart, bodyStart + len);
      this.buffer = this.buffer.slice(bodyStart + len);
      this.handleMessage(JSON.parse(body));
    }
  }

  private handleMessage(msg: any): void {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === "textDocument/publishDiagnostics") {
      const uri = msg.params?.uri || "";
      const file = uri.replace(/^file:\/\//, "");
      this.diagnostics = (msg.params?.diagnostics || []).map((d: any) => ({
        file,
        line: (d.range?.start?.line ?? 0) + 1,
        message: d.message,
        severity: ["Error", "Warning", "Info", "Hint"][(d.severity || 1) - 1] || "Info",
      }));
    }
  }

  private send(method: string, params: any): Promise<any> {
    this.start();
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc!.stdin!.write(header + body);
    });
  }

  private uri(file: string): string {
    return "file://" + path.resolve(file);
  }

  async open(file: string): Promise<void> {
    const content = fs.readFileSync(file, "utf-8");
    await this.send("textDocument/didOpen", {
      textDocument: { uri: this.uri(file), languageId: this.lang, version: 1, text: content },
    });
  }

  async getDiagnostics(file: string): Promise<Diagnostic[]> {
    // Force a sync by requesting a definition on a no-op; diagnostics arrive
    // via publishDiagnostics after didOpen. Give the server a tick to respond.
    await new Promise((r) => setTimeout(r, 300));
    return this.diagnostics.filter((d) => d.file === path.resolve(file));
  }

  async definition(file: string, line: number, character: number): Promise<Definition | null> {
    const res = await this.send("textDocument/definition", {
      textDocument: { uri: this.uri(file) },
      position: { line: line - 1, character },
    });
    if (!res) return null;
    const target = Array.isArray(res) ? res[0] : res;
    if (!target?.uri) return null;
    return {
      file: target.uri.replace(/^file:\/\//, ""),
      line: (target.range?.start?.line ?? 0) + 1,
      character: target.range?.start?.character ?? 0,
    };
  }

  close(): void {
    try { this.proc?.stdin?.end(); } catch { /* ignore */ }
    try { this.proc?.kill(); } catch { /* ignore */ }
    this.proc = null;
  }
}

const clients = new Map<string, LspClient>();

function langFor(file: string): string | null {
  return EXT_TO_LANG[path.extname(file).toLowerCase()] || null;
}

function getClient(lang: string): LspClient | null {
  const cfg = loadLspConfig()[lang];
  if (!cfg) return null;
  let c = clients.get(lang);
  if (!c) {
    c = new LspClient(lang, cfg);
    clients.set(lang, c);
  }
  return c;
}

// Get diagnostics for a file. Returns [] if no LSP server is configured for it.
export async function lspDiagnostics(file: string): Promise<Diagnostic[]> {
  const lang = langFor(file);
  if (!lang) return [];
  const client = getClient(lang);
  if (!client) return [];
  try {
    await client.open(file);
    return await client.getDiagnostics(file);
  } catch {
    return [];
  }
}

// Go to definition. Returns null if unavailable.
export async function lspDefinition(file: string, line: number, character: number): Promise<Definition | null> {
  const lang = langFor(file);
  if (!lang) return null;
  const client = getClient(lang);
  if (!client) return null;
  try {
    await client.open(file);
    return await client.definition(file, line, character);
  } catch {
    return null;
  }
}

export function closeLspClients(): void {
  for (const c of clients.values()) c.close();
  clients.clear();
}

export function listLspServers(): string[] {
  return Object.keys(loadLspConfig());
}
