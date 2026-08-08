// ─── delegate_task ──────────────────────────────────────────────────────────
// Sub-agent delegation: hands a self-contained subtask to a fresh utility
// agent (with the same toolset) and returns its final text output. Lets the
// main agent parallelize independent work (e.g. "research these three files
// and report back") without bloating its own context with the intermediate
// tool calls.
//
// SAFETY: the sub-agent runs the SAME tools (execute_bash, write_file, etc.),
// so it inherits the workspace confinement, confirmation prompts, and loop
// guard. It runs sequentially — the main LLM call has already completed when a
// tool executes, so this does not collide with OLLAMA_NUM_PARALLEL=1.

import { FunctionTool } from "@google/adk";
import { z } from "zod";
import { runUtilityAgent } from "../utility.ts";
import { allTools } from "./index.ts";
import { c, printToolCall, printToolResult, stopSpinner } from "../ui.ts";

// Set by cli.ts to the live agent's model so the sub-agent follows the
// currently active model (including after /model switches).
let delegateModel: any = null;
export function setDelegateModel(model: any) {
  delegateModel = model;
}

const DELEGATE_SYSTEM_PROMPT = `You are a sub-agent working on a single, self-contained subtask for a parent coding agent. You have the same tools as the parent (read_file, write_file, edit_file, execute_bash, grep_search, git_*, etc.).

Rules:
1. Focus ONLY on your assigned subtask. Do not expand scope.
2. Use tools to gather information and make changes as needed.
3. When done, return a concise report of what you did and the result. This report goes back to the parent agent, so be factual and specific (file paths, key findings, what changed).
4. Do not ask the parent questions. Do not narrate your reasoning. Just do the work and report.`;

export const delegateTask = new FunctionTool({
  name: "delegate_task",
  description: "Delegate a self-contained subtask to a sub-agent that runs with the same tools and returns a report. Use for independent research or isolated changes you want to keep out of your own context. The sub-agent runs sequentially and shares your workspace, git, and confirmation guards.",
  parameters: z.object({
    task: z.string().describe("A self-contained, unambiguous description of the subtask for the sub-agent to complete."),
    context: z.string().optional().describe("Optional background context (file paths, constraints) to give the sub-agent."),
  }),
  execute: async ({ task, context }) => {
    stopSpinner();
    printToolCall("delegate_task", { task, context });

    if (!delegateModel) {
      printToolResult(c.error("delegate_task unavailable: no active model."));
      return { status: "error", message: "delegate_task is not available because no model is active." };
    }

    const userPrompt = context
      ? `Subtasks:\n${task}\n\nBackground context:\n${context}`
      : `Subtasks:\n${task}`;

    try {
      const report = await runUtilityAgent(delegateModel, DELEGATE_SYSTEM_PROMPT, userPrompt, {
        tools: allTools,
      });
      printToolResult(c.meta(`[delegate_task] sub-agent returned ${report.length} chars`));
      return { status: "success", report };
    } catch (err: any) {
      printToolResult(c.error(`delegate_task failed: ${err.message}`));
      return { status: "error", message: `Sub-agent failed: ${err.message}` };
    }
  },
});
