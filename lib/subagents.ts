// ─── Named Sub-Agents ─────────────────────────────────────────────────────────
// opencode-style sub-agents: named, configurable agents with their own system
// prompts and tool subsets. The main agent can dispatch a subtask to any of
// them via the `delegate_to_agent` tool, keeping the parent's context clean.
//
// Built-in agents are defined below. Users can add their own in the config
// file (see loadCustomAgents) — each entry is { name, description, instruction,
// tools } where tools is a list of tool names to expose (default: all).

import { FunctionTool } from "@google/adk";
import { z } from "zod";
import fs from "fs";
import path from "path";
import { runUtilityAgent } from "./utility.ts";
import { allTools } from "./tools/index.ts";
import { c, printToolCall, printToolResult, stopSpinner } from "./ui.ts";

export interface SubAgentDef {
  name: string;
  description: string;
  instruction: string;
  tools?: string[]; // tool names to expose; undefined = all
}

// The full toolset, keyed by name, so we can filter per-agent. Built lazily
// (not at module load) to avoid a circular import with tools/index.ts.
let toolByName: Map<string, any> | null = null;
function getToolMap(): Map<string, any> {
  if (!toolByName) {
    toolByName = new Map();
    for (const t of allTools) {
      toolByName.set(t.name, t);
    }
  }
  return toolByName;
}

const BUILTIN_AGENTS: SubAgentDef[] = [
  {
    name: "reviewer",
    description: "Adversarially reviews code/diffs for bugs, security, and style. Use for a second opinion on changes.",
    instruction: `You are a highly critical, adversarial senior code reviewer. Analyze the given code or diff for logical bugs, regressions, syntax errors, edge cases, performance bottlenecks, and security flaws. Present a concise, triaged report rating severity (Critical / Warning / Info). Be direct and specific.`,
  },
  {
    name: "planner",
    description: "Breaks a large task into a structured, ordered implementation plan. Use before starting big multi-file work.",
    instruction: `You are a senior software architect. Given a user request and repo state, produce a concise, structured implementation plan: a SUMMARY, ordered STEPS (each with file, action, detail), and RISKS. Prefer modifying existing files over creating new ones. Order steps so dependencies come first.`,
  },
  {
    name: "tester",
    description: "Writes tests for a target following the project's existing test conventions.",
    instruction: `You are a test-writing agent. Given a target (file or feature), write appropriate tests following the project's existing test framework and conventions. Read the code first to understand behavior, then write the test file. Report what you created and how to run it.`,
  },
  {
    name: "researcher",
    description: "Gathers and summarizes information from the codebase or the web. Use for investigation that shouldn't bloat the parent's context.",
    instruction: `You are a research agent. Given a question, gather relevant information using your tools (read_file, grep_search, semantic_search, web_fetch) and return a concise, factual summary with file paths and key findings. Do not modify any files.`,
  },
];

// Custom agents from config: { "subagents": [ { name, description, instruction, tools } ] }
function loadCustomAgents(): SubAgentDef[] {
  const candidates = [
    path.join(process.cwd(), ".ollama-code.json"),
    path.join(process.env.HOME || process.cwd(), ".ollama-code", "config.json"),
  ];
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
        const list = raw?.subagents;
        if (Array.isArray(list)) {
          return list
            .filter((a: any) => a && typeof a.name === "string" && typeof a.instruction === "string")
            .map((a: any) => ({
              name: a.name,
              description: a.description || a.name,
              instruction: a.instruction,
              tools: Array.isArray(a.tools) ? a.tools : undefined,
            }));
        }
      }
    } catch {
      // ignore corrupt config
    }
  }
  return [];
}

let customAgents: SubAgentDef[] = loadCustomAgents();

export function reloadSubAgents(): number {
  customAgents = loadCustomAgents();
  return customAgents.length;
}

export function listSubAgents(): SubAgentDef[] {
  return [...BUILTIN_AGENTS, ...customAgents];
}

function resolveTools(def: SubAgentDef): any[] {
  if (!def.tools) return allTools;
  const map = getToolMap();
  const resolved: any[] = [];
  for (const name of def.tools) {
    const t = map.get(name);
    if (t) resolved.push(t);
  }
  return resolved;
}

// Set by cli.ts to the live agent's model so sub-agents follow /model switches.
let delegateModel: any = null;
export function setSubAgentModel(model: any) {
  delegateModel = model;
}

// Tool: delegate_to_agent
export const delegateToAgent = new FunctionTool({
  name: "delegate_to_agent",
  description: "Dispatch a self-contained subtask to a named sub-agent (reviewer, planner, tester, researcher, or a custom one from config). The sub-agent runs with its own focused prompt and tool subset, and returns a report. Use to keep complex work out of your own context.",
  parameters: z.object({
    agent: z.string().describe("The name of the sub-agent to dispatch to (e.g. 'reviewer', 'planner', 'tester', 'researcher')."),
    task: z.string().describe("A self-contained, unambiguous description of the subtask."),
    context: z.string().optional().describe("Optional background context (file paths, constraints)."),
  }),
  execute: async ({ agent, task, context }) => {
    stopSpinner();
    printToolCall("delegate_to_agent", { agent, task, context });

    if (!delegateModel) {
      printToolResult(c.error("delegate_to_agent unavailable: no active model."));
      return { status: "error", message: "delegate_to_agent is not available because no model is active." };
    }

    const def = listSubAgents().find((a) => a.name === agent);
    if (!def) {
      const names = listSubAgents().map((a) => a.name).join(", ");
      printToolResult(c.error(`Unknown sub-agent "${agent}". Available: ${names}`));
      return { status: "error", message: `Unknown sub-agent "${agent}". Available: ${names}` };
    }

    const userPrompt = context
      ? `Subtasks:\n${task}\n\nBackground context:\n${context}`
      : `Subtasks:\n${task}`;

    try {
      const report = await runUtilityAgent(delegateModel, def.instruction, userPrompt, {
        tools: resolveTools(def),
      });
      printToolResult(c.meta(`[delegate_to_agent:${agent}] returned ${report.length} chars`));
      return { status: "success", report };
    } catch (err: any) {
      printToolResult(c.error(`delegate_to_agent failed: ${err.message}`));
      return { status: "error", message: `Sub-agent failed: ${err.message}` };
    }
  },
});
