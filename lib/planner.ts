// ─── Multi-File Planner ─────────────────────────────────────────────────────
// A plan-then-execute phase. Before the main agent starts writing code, a
// lightweight planner pass analyzes the request and the current repo state,
// then produces a structured plan (files to touch, order of operations,
// risks). The plan is injected into the main agent's context so it can execute
// deliberately instead of thrashing on big multi-file tasks.
//
// The planner runs BEFORE the main turn's LLM call, so it does not collide
// with the OLLAMA_NUM_PARALLEL=1 constraint.

import { runUtilityAgent } from "./utility.ts";

export interface PlanStep {
  file: string;
  action: string;
  detail: string;
}

export interface Plan {
  summary: string;
  steps: PlanStep[];
  risks: string[];
}

const PLANNER_SYSTEM_PROMPT = `You are a senior software architect. Given a user request and the current repository state, produce a concise, structured implementation plan.

Return your plan in EXACTLY this format (no markdown code fences, no preamble):

SUMMARY: <one or two sentences describing the overall approach>

STEPS:
- FILE: <relative path> | ACTION: <create|modify|delete|run|read> | DETAIL: <what to do here>

RISKS:
- <a risk or dependency to watch out for>

Rules:
1. Break the work into the smallest sensible set of files/steps. Prefer modifying existing files over creating new ones.
2. Order steps so dependencies come first (e.g. read before edit, define before use).
3. Only include steps that are actually needed. Do not pad.
4. If the request is a question or needs no code change, return SUMMARY only with no STEPS.`;

export async function generatePlan(
  model: any,
  userRequest: string,
  gitContext: string,
  memoryContext: string
): Promise<Plan> {
  const userPrompt = `${gitContext}${memoryContext}\n\nUser request: ${userRequest}`;
  const raw = (await runUtilityAgent(model, PLANNER_SYSTEM_PROMPT, userPrompt)).trim();

  return parsePlan(raw);
}

// Parse the planner's structured output into a Plan object. Tolerant of the
// small-model quirks we already handle elsewhere (extra whitespace, missing
// sections, trailing punctuation).
export function parsePlan(raw: string): Plan {
  const plan: Plan = { summary: "", steps: [], risks: [] };

  const summaryMatch = raw.match(/SUMMARY:\s*(.+)/i);
  if (summaryMatch) plan.summary = summaryMatch[1].trim();

  const stepsSection = raw.match(/STEPS:\s*([\s\S]*?)(?=\nRISKS:|\nRISKS\s*$|$)/i);
  if (stepsSection) {
    const stepLines = stepsSection[1].split("\n");
    for (const line of stepLines) {
      const m = line.match(/-\s*FILE:\s*([^\|]+)\|\s*ACTION:\s*([^\|]+)\|\s*DETAIL:\s*(.+)/i);
      if (m) {
        plan.steps.push({
          file: m[1].trim(),
          action: m[2].trim().toLowerCase(),
          detail: m[3].trim(),
        });
      }
    }
  }

  const risksSection = raw.match(/RISKS:\s*([\s\S]*)$/i);
  if (risksSection) {
    for (const line of risksSection[1].split("\n")) {
      const trimmed = line.replace(/^-\s*/, "").trim();
      if (trimmed) plan.risks.push(trimmed);
    }
  }

  return plan;
}

// Render the plan as a compact block injected into the main agent's context.
export function renderPlan(plan: Plan): string {
  if (!plan.summary && plan.steps.length === 0) {
    return "";
  }
  const lines: string[] = [];
  lines.push("---");
  lines.push("IMPLEMENTATION PLAN (follow this order):");
  if (plan.summary) lines.push(`Approach: ${plan.summary}`);
  for (const step of plan.steps) {
    lines.push(`- [${step.action}] ${step.file}: ${step.detail}`);
  }
  if (plan.risks.length > 0) {
    lines.push("Risks:");
    for (const r of plan.risks) lines.push(`  - ${r}`);
  }
  lines.push("---");
  return lines.join("\n");
}
