// ─── GitHub Integration (gh CLI) ─────────────────────────────────────────────
// Thin wrappers over the `gh` CLI for common GitHub workflows: PRs, issues,
// and comments. Requires `gh` to be installed and authenticated. Each tool
// shells out to `gh` and returns its stdout, so the model can read issues,
// open PRs, and comment without leaving the CLI.

import { FunctionTool } from "@google/adk";
import { z } from "zod";
import { execFile } from "child_process";

function runGh(args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile("gh", args, { encoding: "utf-8", timeout: 30000 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, out: stdout || "", err: (stderr || error.message).trim() });
      } else {
        resolve({ ok: true, out: stdout, err: "" });
      }
    });
  });
}

// Tool: gh_pr
export const ghPr = new FunctionTool({
  name: "gh_pr",
  description: "Create a GitHub pull request from the current branch, or list/view PRs. Requires the gh CLI to be installed and authenticated.",
  parameters: z.object({
    action: z.enum(["create", "list", "view"]).describe("What to do: create a PR, list open PRs, or view one."),
    title: z.string().optional().describe("PR title (required for create)."),
    body: z.string().optional().describe("PR body/description (optional for create)."),
    number: z.string().optional().describe("PR number (for view)."),
  }),
  execute: async ({ action, title, body, number }) => {
    if (action === "create") {
      if (!title) return { status: "error", message: "A title is required to create a PR." };
      const args = ["pr", "create", "--title", title];
      if (body) args.push("--body", body);
      const r = await runGh(args);
      return r.ok
        ? { status: "success", message: r.out.trim() }
        : { status: "error", message: r.err };
    }
    if (action === "list") {
      const r = await runGh(["pr", "list"]);
      return r.ok
        ? { status: "success", message: r.out.trim() || "No open PRs." }
        : { status: "error", message: r.err };
    }
    // view
    const r = await runGh(["pr", "view", number || ""]);
    return r.ok
      ? { status: "success", message: r.out.trim() }
      : { status: "error", message: r.err };
  },
});

// Tool: gh_issue
export const ghIssue = new FunctionTool({
  name: "gh_issue",
  description: "Create or list GitHub issues. Requires the gh CLI to be installed and authenticated.",
  parameters: z.object({
    action: z.enum(["create", "list"]).describe("What to do: create an issue or list open issues."),
    title: z.string().optional().describe("Issue title (required for create)."),
    body: z.string().optional().describe("Issue body/description (optional for create)."),
  }),
  execute: async ({ action, title, body }) => {
    if (action === "create") {
      if (!title) return { status: "error", message: "A title is required to create an issue." };
      const args = ["issue", "create", "--title", title];
      if (body) args.push("--body", body);
      const r = await runGh(args);
      return r.ok
        ? { status: "success", message: r.out.trim() }
        : { status: "error", message: r.err };
    }
    const r = await runGh(["issue", "list"]);
    return r.ok
      ? { status: "success", message: r.out.trim() || "No open issues." }
      : { status: "error", message: r.err };
  },
});

// Tool: gh_comment
export const ghComment = new FunctionTool({
  name: "gh_comment",
  description: "Add a comment to a GitHub issue or pull request. Requires the gh CLI to be installed and authenticated.",
  parameters: z.object({
    number: z.string().describe("The issue or PR number to comment on."),
    body: z.string().describe("The comment text."),
  }),
  execute: async ({ number, body }) => {
    const r = await runGh(["issue", "comment", number, "--body", body]);
    return r.ok
      ? { status: "success", message: r.out.trim() || "Comment added." }
      : { status: "error", message: r.err };
  },
});
