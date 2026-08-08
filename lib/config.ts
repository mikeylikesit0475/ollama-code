// ─── Unified Config ───────────────────────────────────────────────────────────
// A single per-project config file (.ollama-code.json) that drives model,
// permissions, sub-agents, MCP servers, plugins, and custom commands — the
// opencode.json equivalent. Falls back to ~/.ollama-code/config.json for
// global settings (model + sandbox persistence).
//
// Precedence: <workspace>/.ollama-code.json wins over the global config for
// the keys it defines; the global file still holds the persisted model/sandbox
// choice written by the CLI.

import fs from "fs";
import path from "path";

export interface CustomCommand {
  name: string;          // without the leading slash
  description: string;
  prompt: string;        // template; {input} is replaced with the args
  tools?: string[];      // optional tool subset (default: all)
}

export interface UnifiedConfig {
  model?: string;
  cloud?: boolean;
  sandbox?: boolean;
  permissions?: { allow?: string[]; deny?: string[]; ask?: string[] };
  subagents?: any[];
  mcpServers?: Record<string, any>;
  plugins?: any[];
  commands?: CustomCommand[];
}

const PROJECT_CONFIG = path.join(process.cwd(), ".ollama-code.json");
const GLOBAL_CONFIG = path.join(process.env.HOME || process.cwd(), ".ollama-code", "config.json");

function readJson(file: string): any | null {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    // corrupt — ignore
  }
  return null;
}

// Load the merged config: project overrides global for defined keys.
export function loadConfig(): UnifiedConfig {
  const global = readJson(GLOBAL_CONFIG) || {};
  const project = readJson(PROJECT_CONFIG) || {};
  const merged: UnifiedConfig = {};

  if (project.model !== undefined) merged.model = project.model;
  else if (global.model !== undefined) merged.model = global.model;
  if (project.cloud !== undefined) merged.cloud = project.cloud;
  else if (global.cloud !== undefined) merged.cloud = global.cloud;
  if (project.sandbox !== undefined) merged.sandbox = project.sandbox;
  else if (global.sandbox !== undefined) merged.sandbox = global.sandbox;

  merged.permissions = project.permissions || global.permissions;
  merged.subagents = project.subagents || global.subagents;
  merged.mcpServers = project.mcpServers || global.mcpServers;
  merged.plugins = project.plugins || global.plugins;
  merged.commands = project.commands || global.commands;

  return merged;
}

// Load custom slash commands from config.
export function loadCustomCommands(): CustomCommand[] {
  const cfg = loadConfig();
  if (!Array.isArray(cfg.commands)) return [];
  return cfg.commands
    .filter((c: any) => c && typeof c.name === "string" && typeof c.prompt === "string")
    .map((c: any) => ({
      name: c.name.replace(/^\//, ""),
      description: c.description || c.name,
      prompt: c.prompt,
      tools: Array.isArray(c.tools) ? c.tools : undefined,
    }));
}

// Persist the model + sandbox choice to the global config (survives restarts).
export function persistGlobal(model: string, cloud: boolean, sandbox: boolean): void {
  try {
    fs.mkdirSync(path.dirname(GLOBAL_CONFIG), { recursive: true });
    fs.writeFileSync(GLOBAL_CONFIG, JSON.stringify({ model, cloud, sandbox }, null, 2), "utf-8");
  } catch {
    // best-effort
  }
}

export function loadGlobal(): { model?: string; cloud?: boolean; sandbox?: boolean } {
  const g = readJson(GLOBAL_CONFIG) || {};
  return {
    model: typeof g.model === "string" ? g.model : undefined,
    cloud: typeof g.cloud === "boolean" ? g.cloud : undefined,
    sandbox: typeof g.sandbox === "boolean" ? g.sandbox : undefined,
  };
}
