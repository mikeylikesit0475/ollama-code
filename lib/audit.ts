// ─── Audit Log (/audit) ───────────────────────────────────────────────────────
// A structured, queryable log of every tool call and its outcome. Unlike the
// debug dump (raw request/response payloads), this is a compact, human-readable
// trail: timestamp, tool, args summary, status, and duration. Persisted to
// ~/.ollama-code/audit.log and also kept in memory for the /audit command.

import fs from "fs";
import path from "path";

export interface AuditEntry {
  ts: string;
  tool: string;
  args: string;
  status: string;
  ms: number;
}

const entries: AuditEntry[] = [];
const MAX_MEMORY = 500;

function auditPath(): string {
  return path.join(process.env.HOME || process.cwd(), ".ollama-code", "audit.log");
}

export function recordAudit(tool: string, args: any, status: string, ms: number): void {
  const entry: AuditEntry = {
    ts: new Date().toISOString(),
    tool,
    args: typeof args === "string" ? args : JSON.stringify(args).slice(0, 200),
    status,
    ms,
  };
  entries.push(entry);
  if (entries.length > MAX_MEMORY) entries.shift();
  try {
    fs.mkdirSync(path.dirname(auditPath()), { recursive: true });
    fs.appendFileSync(auditPath(), JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // best-effort
  }
}

export function getAudit(limit = 50): AuditEntry[] {
  return entries.slice(-limit).reverse();
}

export function clearAudit(): void {
  entries.length = 0;
  try { fs.writeFileSync(auditPath(), "", "utf-8"); } catch { /* ignore */ }
}

export function auditLogPath(): string {
  return auditPath();
}
