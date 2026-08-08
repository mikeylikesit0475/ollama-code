// ─── run_background_command, get_background_output, kill_background_job ─────

import { FunctionTool } from "@google/adk";
import { z } from "zod";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { c, confirmAction, printToolCall, printToolResult, stopSpinner } from "../ui.ts";
import { MAX_TOOL_CALLS_PER_TURN, exceedsToolCallCap } from "../loop-guard.ts";
import { isPathInWorkspace, commandReferencesOutsideWorkspace } from "../workspace.ts";
import { isSandboxEnabled, wrapCommand } from "../sandbox.ts";

export interface BackgroundJob {
  process: any;
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
  exitSignal: string | null;
}

export const backgroundJobs = new Map<string, BackgroundJob>();

// /exit calls process.exit() directly (see cli.ts's main loop), which does
// not touch child processes — without this, any dev server/watcher started
// via run_background_command keeps running as an orphan after the CLI quits.
export function killAllBackgroundJobs() {
  for (const job of backgroundJobs.values()) {
    if (job.exitCode === null && job.exitSignal === null) {
      try { job.process.kill(); } catch { /* already dead */ }
    }
  }
}

// Tool 5.6: run_background_command (interactive-like confirmation required)
export const runBackgroundCommand = new FunctionTool({
  name: "run_background_command",
  description: "Start a long-running process (like a dev server or build watcher) in the background.",
  parameters: z.object({
    command: z.string().describe("The exact shell command to run in the background."),
    jobId: z.string().describe("A unique string identifier for this background job (e.g. 'dev-server')."),
    cwd: z.string().optional().describe("Optional relative path to the directory where the command should execute.")
  }),
  execute: async ({ command, jobId, cwd }) => {
    stopSpinner();
    printToolCall("run_background_command", { command, jobId, cwd });

    if (exceedsToolCallCap()) {
      printToolResult(c.error(`HARD STOP: Exceeded ${MAX_TOOL_CALLS_PER_TURN} tool calls.`));
      return { status: "error", message: `EXECUTION HALTED: Maximum tool calls exceeded.` };
    }

    const execCwd = cwd ? path.resolve(process.cwd(), cwd) : process.cwd();
    if (cwd && !fs.existsSync(execCwd)) {
      return { status: "error", message: `The specified directory does not exist: ${cwd}` };
    }

    // Workspace confinement: mirror execute_bash so a background job can't run
    // with a cwd outside the workspace or reference out-of-workspace paths.
    if (!isPathInWorkspace(execCwd)) {
      printToolResult(c.error(`Access Denied: cwd "${cwd}" is outside the workspace.`));
      return { status: "error", message: `Access Denied: cannot start a background job outside the workspace (cwd: "${cwd}").` };
    }
    const escapesWorkspace = commandReferencesOutsideWorkspace(command, execCwd);
    if (escapesWorkspace) {
      console.log(`  ${c.warn("⚠️  This command references paths OUTSIDE the workspace.")}`);
    }

    // Kill existing job with same jobId if running
    if (backgroundJobs.has(jobId)) {
      const existing = backgroundJobs.get(jobId)!;
      if (existing.exitCode === null) {
        try {
          existing.process.kill();
        } catch (e) {}
      }
    }

    const confirmed = await confirmAction(
      escapesWorkspace ? `Allow starting OUT-OF-WORKSPACE background job '${jobId}'?` : `Allow starting background job '${jobId}'?`
    );
    if (!confirmed) {
      printToolResult("Denied by user.");
      return { status: "denied", message: "User aborted background command execution." };
    }

    if (isSandboxEnabled()) {
      console.log(`  ${c.dim("🔒 Sandboxed: network blocked, filesystem confined to workspace.")}`);
    }

    try {
      // When sandboxing is enabled, wrap the command in bwrap to confine the
      // filesystem to the workspace and block the network — mirroring
      // execute_bash so a background job can't reach the network or touch
      // $HOME even with /sandbox on. Falls back to a plain shell spawn when
      // bwrap is unavailable.
      const wrapped = wrapCommand(command, execCwd);
      const child = wrapped
        ? spawn(wrapped.file, wrapped.args, { cwd: execCwd, env: { ...process.env } })
        : spawn(command, { shell: true, cwd: execCwd, env: { ...process.env } });

      const job: BackgroundJob = {
        process: child,
        stdout: [],
        stderr: [],
        exitCode: null,
        exitSignal: null
      };
      backgroundJobs.set(jobId, job);

      child.stdout.on("data", (data: any) => {
        const lines = data.toString().split("\n");
        for (const line of lines) {
          if (line.trim()) {
            job.stdout.push(line);
            if (job.stdout.length > 1000) job.stdout.shift();
          }
        }
      });

      child.stderr.on("data", (data: any) => {
        const lines = data.toString().split("\n");
        for (const line of lines) {
          if (line.trim()) {
            job.stderr.push(line);
            if (job.stderr.length > 1000) job.stderr.shift();
          }
        }
      });

      child.on("exit", (code: number | null, signal: string | null) => {
        job.exitCode = code;
        job.exitSignal = signal;
      });

      child.on("close", (code: number | null, signal: string | null) => {
        job.exitCode = code;
        job.exitSignal = signal;
      });

      printToolResult(c.success(`✓ Started background job '${jobId}'`));
      return { status: "success", message: `Successfully started background job '${jobId}'.` };
    } catch (error: any) {
      printToolResult(c.error(`Error starting background job: ${error.message}`));
      return { status: "error", message: error.message };
    }
  }
});

// Tool 5.7: get_background_output (non-interactive)
export const getBackgroundOutput = new FunctionTool({
  name: "get_background_output",
  description: "Check the run status and retrieve the stdout/stderr output lines of a background job.",
  parameters: z.object({
    jobId: z.string().describe("The unique identifier of the background job to check."),
    limit: z.number().optional().default(100).describe("Max lines of output to return.")
  }),
  execute: async ({ jobId, limit = 100 }) => {
    if (!backgroundJobs.has(jobId)) {
      return { status: "error", message: `No background job found with ID: ${jobId}` };
    }
    const job = backgroundJobs.get(jobId)!;
    const isRunning = job.exitCode === null && job.exitSignal === null;
    const outputLines = [...job.stdout, ...job.stderr];
    const sliced = outputLines.slice(-limit).join("\n");
    return {
      status: "success",
      jobId,
      isRunning,
      exitCode: job.exitCode,
      exitSignal: job.exitSignal,
      output: sliced || "(no output)"
    };
  }
});

// Tool 5.8: kill_background_job (interactive-like confirmation required)
export const killBackgroundJob = new FunctionTool({
  name: "kill_background_job",
  description: "Stop/terminate a running background job.",
  parameters: z.object({
    jobId: z.string().describe("The unique identifier of the background job to terminate.")
  }),
  execute: async ({ jobId }) => {
    stopSpinner();
    printToolCall("kill_background_job", { jobId });
    if (!backgroundJobs.has(jobId)) {
      printToolResult(c.error("Job not found."));
      return { status: "error", message: `No background job found with ID: ${jobId}` };
    }
    const job = backgroundJobs.get(jobId)!;
    if (job.exitCode !== null || job.exitSignal !== null) {
      printToolResult("Job already finished.");
      return { status: "success", message: `Job '${jobId}' has already finished.` };
    }

    const confirmed = await confirmAction(`Kill background job '${jobId}'?`);
    if (!confirmed) {
      printToolResult("Denied by user.");
      return { status: "denied", message: "User aborted kill operation." };
    }

    try {
      job.process.kill();
      job.exitSignal = "SIGTERM"; // Immediately update state registry to dead
      printToolResult(c.success(`✓ Killed background job '${jobId}'`));
      return { status: "success", message: `Successfully killed background job '${jobId}'.` };
    } catch (error: any) {
      printToolResult(c.error(`Error killing job: ${error.message}`));
      return { status: "error", message: error.message };
    }
  }
});
