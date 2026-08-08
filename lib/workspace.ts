// ─── Workspace & Git Helpers ─────────────────────────────────────────────────
// Path confinement, directory/glob walking, and git-repo bootstrapping shared
// across the tool implementations.

import { execSync, execFile } from "child_process";
import fs from "fs";
import path from "path";
import { globToRegex } from "./matchers.ts";
import { c, confirmAction, stopSpinner } from "./ui.ts";

export function isPathInWorkspace(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  const workspaceRoot = path.resolve(process.cwd());
  // Strict equality or root + separator: a bare startsWith(root) would also
  // match sibling paths like /workspace-evil/secret.txt.
  return resolved === workspaceRoot || resolved.startsWith(workspaceRoot + path.sep);
}

// Conservative check for shell commands that reference paths outside the
// workspace. The confirmation prompt is the only other barrier for bash, so
// out-of-workspace commands get an escalated (explicitly worded) warning.
export function commandReferencesOutsideWorkspace(command: string, cwd: string): boolean {
  const tokens = command.match(/[^\s"']+|"([^"]*)"|'([^']*)'/g) || [];
  for (const raw of tokens) {
    const token = raw.replace(/^["']|["']$/g, "");
    if (!token.includes("/")) continue;
    if (/^(https?|git@)/.test(token)) continue; // URLs, not filesystem paths
    if (token.startsWith("~/") || token === "~") return true;
    if (path.isAbsolute(token) && !isPathInWorkspace(token)) return true;
    if (token.includes("..")) {
      const resolved = path.resolve(cwd, token);
      if (!isPathInWorkspace(resolved)) return true;
    }
  }
  return false;
}

// Helper: Recursive directory listing excluding common heavy/irrelevant folders
export function listDirRecursive(dir: string, baseDir = dir, depth = 0, state = { count: 0 }): string[] {
  const homeDir = process.env.HOME;
  const maxDepth = (homeDir && baseDir === homeDir) ? 1 : 5;
  if (depth > maxDepth || state.count >= 1000) {
    return [];
  }
  let results: string[] = [];
  let list: string[] = [];
  try {
    list = fs.readdirSync(dir);
  } catch (err) {
    // Gracefully skip folders we cannot read (e.g. EPERM/EACCES)
    return [];
  }

  for (const file of list) {
    if (state.count >= 1000) {
      break;
    }
    const filePath = path.join(dir, file);
    const relativePath = path.relative(baseDir, filePath);

    if (
      file === "node_modules" ||
      file === "bin" ||
      file === "obj" ||
      file === ".git" ||
      file === "package-lock.json" ||
      file === ".env" ||
      file === ".DS_Store" ||
      file === "Library" ||
      file === "Applications" ||
      file === "Pictures" ||
      file === "Music" ||
      file === "Movies" ||
      file === "Desktop" ||
      file === "Documents" ||
      file === "Downloads" ||
      file === "Public" ||
      file === ".Trash" ||
      file === ".npm" ||
      file === ".nvm" ||
      file === ".cache" ||
      file === ".config" ||
      file === ".vscode" ||
      file === ".ollama" ||
      file === ".ollama-code" ||
      file === ".gemini"
    ) {
      continue;
    }

    try {
      const stat = fs.statSync(filePath);
      if (stat && stat.isDirectory()) {
        results = results.concat(listDirRecursive(filePath, baseDir, depth + 1, state));
      } else {
        results.push(relativePath);
        state.count++;
      }
    } catch (err) {
      // Gracefully skip restricted files/folders we cannot stat
    }
  }
  return results;
}

// Unlike listDirRecursive (depth 5 / 1000 files), this had no caps at all — a
// broad pattern like "**/*" in a large repo could return an unbounded file
// list straight into the model's context. Depth is a bit more generous than
// listDirRecursive's since glob patterns often intentionally target deep
// paths (e.g. "src/**/*.ts"); the result cap also guards against symlink
// cycles turning into runaway recursion.
const GLOB_MAX_DEPTH = 8;
export const GLOB_MAX_RESULTS = 1000;

// Helper: Custom glob matcher to find matching files without recursive tree bloat
export function globFiles(pattern: string): string[] {
  const regex = globToRegex(pattern);

  const matched: string[] = [];
  function walk(dir: string, depth: number) {
    if (depth > GLOB_MAX_DEPTH || matched.length >= GLOB_MAX_RESULTS) return;
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const file of files) {
      if (matched.length >= GLOB_MAX_RESULTS) return;
      if (
        file === "node_modules" ||
        file === ".git" ||
        file === "dist" ||
        file === "build" ||
        file === ".gemini"
      ) {
        continue;
      }
      const fullPath = path.join(dir, file);
      const relPath = path.relative(process.cwd(), fullPath);
      let isDir = false;
      try {
        isDir = fs.statSync(fullPath).isDirectory();
      } catch {}

      if (regex.test(relPath)) {
        matched.push(relPath);
      }
      if (isDir) {
        walk(fullPath, depth + 1);
      }
    }
  }
  walk(process.cwd(), 0);
  return matched;
}

// Helper: Get Git status and diff summary to feed into the model's context window.
// Async (execFile, not execSync) so it never blocks the event loop mid-turn.
let lastGitStatusRaw = "";
function runGit(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", args, { encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }, (err, stdout) => {
      resolve(err ? "" : stdout);
    });
  });
}
export async function getGitContext(): Promise<string> {
  try {
    const [status, diff] = await Promise.all([
      runGit(["status", "--porcelain"]),
      runGit(["diff", "--stat"]),
    ]);

    if (!status.trim()) {
      lastGitStatusRaw = "";
      return "Git Status: Working directory clean. No uncommitted changes.";
    }

    if (status === lastGitStatusRaw) {
      const lines = status.split("\n").filter(l => l.trim());
      const untrackedCount = lines.filter(l => l.startsWith("??")).length;
      const trackedLines = lines.filter(l => !l.startsWith("??"));
      return `--- Current Git State ---\n(Unchanged since previous turn)\nTracked Modified Files:\n${trackedLines.join("\n") || "None"}\nUntracked Files: ${untrackedCount} files, unchanged.\nDiff Summary:\n${diff}`;
    }

    lastGitStatusRaw = status;
    const lines = status.split("\n").filter(l => l.trim());
    const untracked = lines.filter(l => l.startsWith("??"));
    const tracked = lines.filter(l => !l.startsWith("??"));

    let untrackedSection = "";
    if (untracked.length > 10) {
      untrackedSection = `Untracked Files: ${untracked.length} files (first 5 shown):\n${untracked.slice(0, 5).join("\n")}\n...`;
    } else {
      untrackedSection = `Untracked Files:\n${untracked.join("\n")}`;
    }

    return `--- Current Git State ---\nTracked Modified Files:\n${tracked.join("\n") || "None"}\n${untrackedSection}\nDiff Summary:\n${diff}`;
  } catch (error) {
    return "Git Status: Not a git repository or git is not installed.";
  }
}

export async function ensureGitRepository(): Promise<boolean> {
  try {
    execSync("git rev-parse --is-inside-work-tree", { stdio: "ignore" });
    return true;
  } catch {
    stopSpinner();
    const initialize = await confirmAction("Git is not initialized in this directory. Run 'git init' now?");
    if (initialize) {
      try {
        execSync("git init", { stdio: "inherit" });
        console.log(`  ${c.success("✓ Initialized empty Git repository.")}`);
        return true;
      } catch (err: any) {
        console.log(`  ${c.error(`Failed to initialize git: ${err.message}`)}`);
      }
    }
    return false;
  }
}
