// ─── git_commit, git_status, git_add, git_diff, git_log, git_restore ────────

import { FunctionTool } from "@google/adk";
import { z } from "zod";
import { execFileSync, execSync } from "child_process";
import path from "path";
import { c, confirmAction, printToolCall, printToolResult, stopSpinner } from "../ui.ts";
import { isPathInWorkspace, ensureGitRepository } from "../workspace.ts";
import { confirmOrAllow } from "../permissions.ts";

// Tool 7: git_commit with inline confirmation
export const gitCommit = new FunctionTool({
  name: "git_commit",
  description: "Commit current staged modifications to the git repository. Staged modifications must be added via git_add first, or modified tracked files will be automatically staged.",
  parameters: z.object({
    message: z.string().describe("A concise commit message describing the changes.")
  }),
  execute: async ({ message }) => {
    stopSpinner();
    printToolCall("git_commit", { message });
    const isGit = await ensureGitRepository();
    if (!isGit) {
      printToolResult(c.error("Git is not initialized in this directory."));
      return { status: "error", message: "Git is not initialized in this directory. Please ask the user to initialize git first." };
    }

    const confirmed = await confirmOrAllow("git_commit", { message }, () => confirmAction("Commit changes?"));

    if (!confirmed.proceed) {
      if (confirmed.reason === "deny") {
        printToolResult(c.error("BLOCKED by permission rules."));
        return { status: "denied", message: "User aborted Git commit." };
      }
      printToolResult("Denied by user.");
      return { status: "denied", message: "User aborted Git commit." };
    }

    try {
      // Stage only tracked files (prevents untracked binaries from being staged)
      execSync("git add -u", { stdio: "ignore" });
      const stdout = execFileSync("git", ["commit", "-m", message], { encoding: "utf-8" });
      printToolResult(c.success(stdout.trim()));
      return { status: "success", message: stdout };
    } catch (error: any) {
      return { status: "error", message: error.message };
    }
  }
});

// Tool 8: git_status (non-interactive)
export const gitStatus = new FunctionTool({
  name: "git_status",
  description: "View the status of the git repository (staged, unstaged, and untracked files).",
  parameters: z.object({}),
  execute: async () => {
    try {
      const isGit = await ensureGitRepository();
      if (!isGit) return { status: "error", message: "Git is not initialized in this directory." };
      const stdout = execSync("git status --short", { encoding: "utf-8" });
      return { status: "success", message: stdout || "Working tree clean" };
    } catch (error: any) {
      return { status: "error", message: error.message };
    }
  }
});

// Tool 9: git_add with inline confirmation
export const gitAdd = new FunctionTool({
  name: "git_add",
  description: "Stage a specific file for git commit. Allows selective staging rather than adding everything.",
  parameters: z.object({
    path: z.string().describe("Relative path to the file to stage.")
  }),
  execute: async ({ path: filePath }) => {
    stopSpinner();
    printToolCall("git_add", { path: filePath });
    const isGit = await ensureGitRepository();
    if (!isGit) return { status: "error", message: "Git is not initialized in this directory." };

    const fullPath = path.resolve(filePath);
    if (!isPathInWorkspace(fullPath)) {
      return { status: "error", message: "Access Denied: Path is outside workspace." };
    }

    const relativeDisplayPath = path.relative(process.cwd(), fullPath) || filePath;
    const confirmed = await confirmOrAllow("git_add", { path: filePath }, () => confirmAction(`Stage ${relativeDisplayPath}?`));
    if (!confirmed.proceed) {
      if (confirmed.reason === "deny") {
        printToolResult(c.error("BLOCKED by permission rules."));
        return { status: "denied", message: "User aborted Git add." };
      }
      printToolResult("Denied by user.");
      return { status: "denied", message: "User aborted Git add." };
    }

    try {
      execFileSync("git", ["add", "--", filePath]);
      printToolResult(c.success(`✓ Staged ${relativeDisplayPath}`));
      return { status: "success", message: `Successfully staged ${filePath}` };
    } catch (error: any) {
      printToolResult(c.error(`Error staging ${relativeDisplayPath}: ${error.message}`));
      return { status: "error", message: error.message };
    }
  }
});

// Tool 10: git_diff (non-interactive)
export const gitDiff = new FunctionTool({
  name: "git_diff",
  description: "View current unstaged differences in the git repository.",
  parameters: z.object({}),
  execute: async () => {
    try {
      const isGit = await ensureGitRepository();
      if (!isGit) return { status: "error", message: "Git is not initialized in this directory." };
      const stdout = execSync("git diff", { encoding: "utf-8" });
      return { status: "success", message: stdout || "No unstaged changes" };
    } catch (error: any) {
      return { status: "error", message: error.message };
    }
  }
});

// Tool 11: git_log (non-interactive)
export const gitLog = new FunctionTool({
  name: "git_log",
  description: "View the recent commit log history.",
  parameters: z.object({
    count: z.number().optional().default(5).describe("Number of recent commits to list.")
  }),
  execute: async ({ count = 5 }) => {
    try {
      const isGit = await ensureGitRepository();
      if (!isGit) return { status: "error", message: "Git is not initialized in this directory." };
      const stdout = execFileSync("git", ["log", "-n", String(Math.max(1, Math.min(100, count))), "--oneline"], { encoding: "utf-8" });
      return { status: "success", message: stdout || "No commit history found" };
    } catch (error: any) {
      return { status: "error", message: error.message };
    }
  }
});

// Tool 13: git_restore
export const gitRestore = new FunctionTool({
  name: "git_restore",
  description: "Discard uncommitted changes in a specific file or the entire working tree.",
  parameters: z.object({
    path: z.string().describe("Relative path to the file to restore. Use '.' to restore all files.")
  }),
  execute: async ({ path: filePath }) => {
    stopSpinner();
    printToolCall("git_restore", { path: filePath });

    const fullPath = path.resolve(filePath);
    if (!isPathInWorkspace(fullPath)) {
      printToolResult(c.error(`Access Denied: "${filePath}" is outside the workspace.`));
      return { status: "error", message: "Access Denied: Path is outside workspace." };
    }

    const confirmed = await confirmOrAllow("git_restore", { path: filePath }, () => confirmAction(`Are you sure you want to discard all uncommitted changes in '${filePath}'?`));
    if (!confirmed.proceed) {
      if (confirmed.reason === "deny") {
        printToolResult(c.error("BLOCKED by permission rules."));
        return { status: "denied", message: "User aborted git restore operation." };
      }
      printToolResult("Denied by user.");
      return { status: "denied", message: "User aborted git restore operation." };
    }

    try {
      execFileSync("git", ["restore", "--", filePath]);
      printToolResult(c.success(`✓ Discarded uncommitted changes in ${filePath}`));
      return { status: "success", message: `Successfully discarded uncommitted changes in ${filePath}.` };
    } catch (error: any) {
      printToolResult(c.error(`Error during git restore: ${error.message}`));
      return { status: "error", message: error.message };
    }
  }
});
