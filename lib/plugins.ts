// ─── Plugin / Hook Registry ──────────────────────────────────────────────────
// opencode-style lifecycle hooks. Users can register plugins in the config file
// that run at well-defined points in the agent loop, without editing cli.ts.
//
// Config:
//   {
//     "plugins": [
//       {
//         "name": "my-plugin",
//         "hooks": {
//           "beforeTool":   "console.log('[hook] before tool', name, args)",
//           "afterTool":    "console.log('[hook] after tool', name, result)",
//           "beforeTurn":   "console.log('[hook] before turn', prompt)",
//           "afterTurn":    "console.log('[hook] after turn')"
//         }
//       }
//     ]
//   }
//
// Each hook is a JS expression evaluated with a context object:
//   { name, args, result, prompt, sessionId, model, cwd }
// Hooks are best-effort: a throwing hook is caught and logged, never fatal.

import fs from "fs";
import path from "path";

export type HookName = "beforeTool" | "afterTool" | "beforeTurn" | "afterTurn";

export interface PluginDef {
  name: string;
  hooks: Partial<Record<HookName, string>>;
}

interface HookContext {
  name?: string;
  args?: any;
  result?: any;
  prompt?: string;
  sessionId?: string;
  model?: string;
  cwd?: string;
}

let plugins: PluginDef[] = [];

function loadPlugins(): PluginDef[] {
  const candidates = [
    path.join(process.cwd(), ".ollama-code.json"),
    path.join(process.env.HOME || process.cwd(), ".ollama-code", "config.json"),
  ];
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
        const list = raw?.plugins;
        if (Array.isArray(list)) {
          return list
            .filter((p: any) => p && typeof p.name === "string" && p.hooks && typeof p.hooks === "object")
            .map((p: any) => ({
              name: p.name,
              hooks: {
                beforeTool: typeof p.hooks.beforeTool === "string" ? p.hooks.beforeTool : undefined,
                afterTool: typeof p.hooks.afterTool === "string" ? p.hooks.afterTool : undefined,
                beforeTurn: typeof p.hooks.beforeTurn === "string" ? p.hooks.beforeTurn : undefined,
                afterTurn: typeof p.hooks.afterTurn === "string" ? p.hooks.afterTurn : undefined,
              },
            }));
        }
      }
    } catch {
      // ignore corrupt config
    }
  }
  return [];
}

export function reloadPlugins(): number {
  plugins = loadPlugins();
  return plugins.length;
}

export function listPlugins(): PluginDef[] {
  return plugins;
}

// Run a single hook expression. Best-effort: never throws.
function runHook(expr: string, ctx: HookContext): void {
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function("ctx", `with (ctx) { ${expr} }`);
    fn(ctx);
  } catch (err: any) {
    console.error(`  ${"\x1b[33m"}⚠️ plugin hook error: ${err.message}${"\x1b[0m"}`);
  }
}

function fire(hook: HookName, ctx: HookContext): void {
  for (const p of plugins) {
    const expr = p.hooks[hook];
    if (expr) runHook(expr, ctx);
  }
}

export const hooks = {
  beforeTool(name: string, args: any) {
    fire("beforeTool", { name, args, cwd: process.cwd() });
  },
  afterTool(name: string, args: any, result: any) {
    fire("afterTool", { name, args, result, cwd: process.cwd() });
  },
  beforeTurn(prompt: string, sessionId?: string, model?: string) {
    fire("beforeTurn", { prompt, sessionId, model, cwd: process.cwd() });
  },
  afterTurn(sessionId?: string, model?: string) {
    fire("afterTurn", { sessionId, model, cwd: process.cwd() });
  },
};
