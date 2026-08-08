// ─── Permission Rules ────────────────────────────────────────────────────────
// Granular, rule-based confirmation control (opencode-style). Instead of a
// blanket [y/N] prompt on every tool call, the user can declare rules in a
// config file that say which tools/paths are always allowed, always denied, or
// still require confirmation.
//
// Config is read from, in order of precedence:
//   1. <workspace>/.ollama-code.json   (per-project, gitignored)
//   2. ~/.ollama-code/config.json      (global)
//
// Format:
//   {
//     "permissions": {
//       "allow": ["git_status", "git_diff", "git_log", "read_file", "read_files"],
//       "deny":  ["execute_bash:rm -rf", "git_restore"],
//       "ask":   ["write_file", "edit_file"]
//     }
//   }
//
// A rule is either a bare tool name ("git_status") or "tool:pattern" where
// pattern is matched against the tool's primary argument (path/command). The
// first matching rule wins; if none match, the tool falls back to its normal
// confirmation prompt.

import fs from "fs";
import path from "path";

export type PermissionDecision = "allow" | "deny" | "ask";

interface PermissionConfig {
  allow?: string[];
  deny?: string[];
  ask?: string[];
}

interface LoadedConfig {
  permissions: PermissionConfig;
  source: string;
}

let cached: LoadedConfig | null = null;

// The primary argument a tool acts on (path, command, etc.). Used to match
// "tool:pattern" rules.
function primaryArg(toolName: string, args: Record<string, any>): string {
  if (args.path !== undefined) return String(args.path);
  if (args.command !== undefined) return String(args.command);
  if (args.filePath !== undefined) return String(args.filePath);
  if (args.cwd !== undefined) return String(args.cwd);
  return "";
}

function ruleMatches(rule: string, toolName: string, arg: string): boolean {
  const colon = rule.indexOf(":");
  if (colon === -1) {
    return rule === toolName;
  }
  const ruleTool = rule.slice(0, colon);
  const pattern = rule.slice(colon + 1);
  if (ruleTool !== toolName) return false;
  if (!pattern) return true;
  // Simple glob-ish match: '*' matches any chars, otherwise substring.
  if (pattern.includes("*")) {
    const re = new RegExp("^" + pattern.split("*").map(escapeRe).join(".*") + "$");
    return re.test(arg);
  }
  return arg.includes(pattern);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function loadConfig(): LoadedConfig {
  if (cached) return cached;
  const candidates = [
    path.join(process.cwd(), ".ollama-code.json"),
    path.join(process.env.HOME || process.cwd(), ".ollama-code", "config.json"),
  ];
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
        const perms = raw?.permissions || {};
        cached = {
          permissions: {
            allow: perms.allow || [],
            deny: perms.deny || [],
            ask: perms.ask || [],
          },
          source: file,
        };
        return cached;
      }
    } catch {
      // Corrupt config — fall through to next candidate / defaults.
    }
  }
  cached = { permissions: {}, source: "" };
  return cached;
}

// Reload the config (e.g. after the user edits it). Returns the source path.
export function reloadPermissions(): string {
  cached = null;
  return loadConfig().source;
}

// Evaluate the permission rules for a tool call. Returns:
//   "allow" — proceed without prompting
//   "deny"  — block the call
//   "ask"   — fall through to the normal confirmation prompt
export function checkPermission(toolName: string, args: Record<string, any> = {}): PermissionDecision {
  const { permissions } = loadConfig();
  const arg = primaryArg(toolName, args);

  for (const rule of permissions.deny || []) {
    if (ruleMatches(rule, toolName, arg)) return "deny";
  }
  for (const rule of permissions.allow || []) {
    if (ruleMatches(rule, toolName, arg)) return "allow";
  }
  for (const rule of permissions.ask || []) {
    if (ruleMatches(rule, toolName, arg)) return "ask";
  }
  return "ask";
}

// Convenience: true when a tool call is explicitly allowed (no prompt needed).
export function isAllowed(toolName: string, args: Record<string, any> = {}): boolean {
  return checkPermission(toolName, args) === "allow";
}

// Convenience: true when a tool call is explicitly denied.
export function isDenied(toolName: string, args: Record<string, any> = {}): boolean {
  return checkPermission(toolName, args) === "deny";
}

// Combined gate for tools: returns true when the call should proceed. Explicitly
// allowed rules skip the prompt; denied rules block; otherwise it falls through
// to the provided confirm() (the tool's normal [y/N] prompt).
export async function confirmOrAllow(
  toolName: string,
  args: Record<string, any>,
  confirm: () => Promise<boolean>
): Promise<{ proceed: boolean; reason: "allow" | "deny" | "ask" }> {
  const decision = checkPermission(toolName, args);
  if (decision === "allow") return { proceed: true, reason: "allow" };
  if (decision === "deny") return { proceed: false, reason: "deny" };
  return { proceed: await confirm(), reason: "ask" };
}
