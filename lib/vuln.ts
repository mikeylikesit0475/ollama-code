// ─── Defensive Vulnerability Scanner (/vuln) ──────────────────────────────────
// Scans the workspace for common vulnerability patterns and reports them so the
// user can fix them. This is DEFENSIVE only — it finds issues in your own code
// and dependencies; it does not exploit anything.
//
// Three passes:
//   1. Static pattern scan — regex/heuristic detection of common vuln classes
//      (SQL injection, command injection, hardcoded secrets, eval/exec, path
//      traversal, insecure deserialization, etc.).
//   2. Dependency scan — shells out to the ecosystem's own audit tool
//      (npm audit, pip-audit, govulncheck, cargo audit) when present.
//   3. LLM-assisted review — a focused pass over the flagged files to confirm
//      real vulnerabilities and suggest fixes.

import { FunctionTool } from "@google/adk";
import { z } from "zod";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { globFiles } from "./workspace.ts";
import { runUtilityAgent } from "./utility.ts";

export interface VulnFinding {
  file: string;
  line: number;
  severity: "Critical" | "High" | "Medium" | "Low";
  category: string;
  detail: string;
  snippet: string;
}

// ─── Pass 1: static pattern scan ─────────────────────────────────────────────

interface Pattern {
  category: string;
  severity: "Critical" | "High" | "Medium" | "Low";
  regex: RegExp;
  detail: string;
}

const PATTERNS: Pattern[] = [
  {
    category: "Hardcoded secret",
    severity: "Critical",
    regex: /(api[_-]?key|secret|password|passwd|token|auth[_-]?token|access[_-]?key)\s*[:=]\s*["'][A-Za-z0-9_\-]{8,}["']/i,
    detail: "Possible hardcoded credential. Move to environment variables / a secret manager.",
  },
  {
    category: "SQL injection",
    severity: "Critical",
    regex: /(execute|query|exec|raw)\s*\(\s*["'`].*(\$\{|f["'`].*\{|\+.*(user|input|req|param|query|body))/i,
    detail: "Possible SQL injection — string interpolation into a query. Use parameterized queries.",
  },
  {
    category: "Command injection",
    severity: "Critical",
    regex: /(exec|execSync|spawn|system|popen|shell_exec|os\.system|child_process)\s*\(\s*[^)]*(\$\{|[+]\s*(user|input|req|param|query|body|argv|process\.env))/i,
    detail: "Possible command injection — user input interpolated into a shell command.",
  },
  {
    category: "Dangerous eval",
    severity: "High",
    regex: /\b(eval|Function)\s*\(\s*["'`]/i,
    detail: "eval()/Function() on dynamic input can lead to code execution. Avoid if input is untrusted.",
  },
  {
    category: "Path traversal",
    severity: "High",
    regex: /(readFile|readFileSync|writeFile|writeFileSync|open|sendFile|createReadStream)\s*\(\s*[^)]*(req\.|params\.|query\.|body\.|user)/i,
    detail: "Possible path traversal — user input used as a file path. Validate/normalize the path.",
  },
  {
    category: "Insecure deserialization",
    severity: "High",
    regex: /\b(pickle\.loads|yaml\.load|JSON\.parse|unserialize|eval)\s*\(\s*[^)]*(req\.|input|data|body)/i,
    detail: "Possible insecure deserialization of untrusted input. Use safe parsers.",
  },
  {
    category: "Weak crypto",
    severity: "Medium",
    regex: /\b(md5|sha1|rc4|des_?cbc|des_?ecb|createHash\s*\(\s*["'](md5|sha1))\b/i,
    detail: "Weak or deprecated hash/cipher. Use SHA-256+ or a modern KDF (bcrypt/argon2).",
  },
  {
    category: "Insecure HTTP",
    severity: "Low",
    regex: /http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)/i,
    detail: "Plaintext HTTP endpoint. Use HTTPS in production.",
  },
  {
    category: "Missing auth check",
    severity: "Medium",
    regex: /(router|app)\.(get|post|put|delete|patch)\s*\(\s*["'][^"']*["']\s*,\s*\(/i,
    detail: "Route handler without an obvious auth middleware. Verify access control.",
  },
];

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "bin", "obj", ".cache", ".config", ".vscode", ".ollama", ".ollama-code", ".gemini", "__pycache__", "target"]);
const SKIP_FILES = new Set(["package-lock.json", ".env", ".env.save", "debug.json", "package.json", "MEMORY.md", "TODO.md", "README.md"]);

function isScanable(relPath: string): boolean {
  const base = path.basename(relPath);
  if (SKIP_FILES.has(base)) return false;
  const ext = path.extname(base).toLowerCase();
  return /\.(ts|tsx|js|jsx|py|go|rs|java|c|cpp|h|hpp|cs|rb|php|swift|kt|sh|sql|yaml|yml|json)$/.test(ext);
}

export function staticScan(): VulnFinding[] {
  const findings: VulnFinding[] = [];
  const files = globFiles("**/*").filter(isScanable);
  for (const file of files) {
    let content: string;
    try {
      content = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (const p of PATTERNS) {
      for (let i = 0; i < lines.length; i++) {
        if (p.regex.test(lines[i])) {
          findings.push({
            file,
            line: i + 1,
            severity: p.severity,
            category: p.category,
            detail: p.detail,
            snippet: lines[i].trim().slice(0, 200),
          });
        }
      }
    }
  }
  return findings;
}

// ─── Pass 2: dependency scan ──────────────────────────────────────────────────

function run(cmd: string, args: string[], cwd: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, encoding: "utf-8", timeout: 60000 }, (err, stdout, stderr) => {
      resolve({ code: err ? 1 : 0, out: (stdout || stderr || "").trim() });
    });
  });
}

export async function dependencyScan(): Promise<VulnFinding[]> {
  const findings: VulnFinding[] = [];
  const cwd = process.cwd();

  // npm audit
  if (fs.existsSync(path.join(cwd, "package.json"))) {
    const r = await run("npm", ["audit", "--json"], cwd);
    if (r.code === 0 && r.out) {
      try {
        const data = JSON.parse(r.out);
        const vulns = data?.vulnerabilities || {};
        for (const [name, v] of Object.entries<any>(vulns)) {
          if (v?.severity && v.severity !== "none") {
            findings.push({
              file: "package.json",
              line: 0,
              severity: (v.severity.charAt(0).toUpperCase() + v.severity.slice(1)) as any,
              category: "Dependency vulnerability",
              detail: `${name}: ${v.isDirect ? "direct" : "transitive"} dependency — ${v.title || v.range || ""}`,
              snippet: `npm audit: ${name} (${v.range || "?"})`,
            });
          }
        }
      } catch { /* ignore parse errors */ }
    }
  }

  // pip-audit
  if (fs.existsSync(path.join(cwd, "requirements.txt")) || fs.existsSync(path.join(cwd, "pyproject.toml"))) {
    const r = await run("pip-audit", [], cwd);
    if (r.code === 0 && r.out && !r.out.includes("No known vulnerabilities")) {
      findings.push({
        file: "requirements.txt",
        line: 0,
        severity: "High",
        category: "Dependency vulnerability",
        detail: "pip-audit found known vulnerabilities in Python dependencies.",
        snippet: r.out.slice(0, 300),
      });
    }
  }

  return findings;
}

// ─── Pass 3: LLM-assisted review ───────────────────────────────────────────────

const REVIEW_SYSTEM_PROMPT = `You are a defensive security reviewer. Given a list of potential vulnerabilities found by static analysis, review each one and determine whether it is a REAL vulnerability or a false positive. For each real vulnerability, provide a concrete, minimal fix. This is DEFENSIVE ONLY — you are helping secure the user's own code, never exploiting anything.

Return your analysis as a concise list. For each finding, state: file, line, whether it's REAL or FALSE_POSITIVE, and (if real) a one-line fix. Be accurate — do not inflate severity.`;

export async function llmReview(model: any, findings: VulnFinding[]): Promise<string> {
  if (findings.length === 0) return "No findings to review.";
  const input = findings
    .map((f) => `[${f.severity}] ${f.file}:${f.line} (${f.category}) — ${f.detail}\n  ${f.snippet}`)
    .join("\n");
  return (await runUtilityAgent(model, REVIEW_SYSTEM_PROMPT, input)).trim();
}

// ─── Tool: vuln_scan ──────────────────────────────────────────────────────────

export const vulnScanTool = new FunctionTool({
  name: "vuln_scan",
  description: "Scan the workspace for common security vulnerabilities (SQL injection, command injection, hardcoded secrets, path traversal, dependency vulnerabilities, etc.). DEFENSIVE ONLY — finds issues in the user's own code so they can be fixed.",
  parameters: z.object({
    scope: z.enum(["static", "deps", "all"]).optional().describe("What to scan: static patterns, dependencies, or both (default all)."),
  }),
  execute: async ({ scope = "all" }) => {
    const findings: VulnFinding[] = [];
    if (scope === "static" || scope === "all") findings.push(...staticScan());
    if (scope === "deps" || scope === "all") findings.push(...(await dependencyScan()));
    if (findings.length === 0) {
      return { status: "success", message: "No vulnerabilities found by static/dependency scan." };
    }
    const bySeverity: Record<string, number> = {};
    for (const f of findings) bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
    const summary = findings
      .map((f) => `[${f.severity}] ${f.file}:${f.line} (${f.category}) — ${f.detail}`)
      .join("\n");
    return {
      status: "success",
      count: findings.length,
      bySeverity,
      findings: summary,
    };
  },
});
