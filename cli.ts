import { LlmAgent, Runner, DatabaseSessionService, setLogLevel, LogLevel, TruncatingContextCompactor, stringifyContent } from "@google/adk";
import { execFileSync, execSync } from "child_process";
import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import {
  c, renderMarkdown, promptInput, confirmAction, printToolCall, printTokenUsage,
  startSpinner, stopSpinner, printHelp, printStatus, printWelcomeBanner,
  configurePromptSuggestions, stream, beginStream, endStream, streamToken,
  printInterruptHint, setAutoApprove,
} from "./lib/ui.ts";
import { getGitContext, ensureGitRepository } from "./lib/workspace.ts";
import { OllamaLlm } from "./lib/ollama-llm.ts";
import { allTools, killAllBackgroundJobs, setDelegateModel, setSubAgentModel, loadMcpTools, closeMcpConnections, listMcpServers } from "./lib/tools/index.ts";
import { resetLoopGuard, loopGuard } from "./lib/loop-guard.ts";
import { isSandboxEnabled, setSandboxEnabled, isBwrapAvailable } from "./lib/sandbox.ts";
import { generatePlan, renderPlan } from "./lib/planner.ts";
import { summarizeHistory } from "./lib/summarizer.ts";
import { scratchpad } from "./lib/scratchpad.ts";
import { compaction } from "./lib/compaction.ts";
import { runUtilityAgent } from "./lib/utility.ts";
import { buildIndex } from "./lib/indexer.ts";
import { reloadPermissions, checkPermission } from "./lib/permissions.ts";
import { listSubAgents, reloadSubAgents } from "./lib/subagents.ts";
import { reloadPlugins, hooks, listPlugins } from "./lib/plugins.ts";
import { loadConfig, loadCustomCommands, persistGlobal, loadGlobal } from "./lib/config.ts";
import { exportToFile, exportToGist } from "./lib/share.ts";
import { lspDiagnostics, lspDefinition, closeLspClients, listLspServers } from "./lib/lsp.ts";
import { sessionBrowser } from "./lib/tui.ts";
import { runHealthChecks } from "./lib/health.ts";
import { recordUsage, resetUsage, getUsage, formatCost } from "./lib/cost.ts";
import { getAudit, clearAudit, auditLogPath } from "./lib/audit.ts";
import { staticScan, dependencyScan, llmReview } from "./lib/vuln.ts";
import { replayRepro, reproDirPath } from "./lib/repro.ts";

// Load environment variables from the .env file next to this script, so config
// resolves correctly regardless of the machine or the directory it's run from.
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(scriptDir, ".env") });

// Avoid global and system git configuration file reads to allow sandboxed git execution
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";

// Suppress ADK internal logging to keep the terminal output clean
setLogLevel(LogLevel.ERROR);

// ─── Local Slash Commands ───────────────────────────────────────────────────

// Only commands with real implementations in the main loop belong here.
// Anything else is autocomplete theater that teaches users (and the model)
// commands that silently do nothing.
const commands = [
  { cmd: '/help', desc: 'Show this help menu' },
  { cmd: '/paste', desc: 'Paste multi-line text directly from your clipboard' },
  { cmd: '/clear', desc: 'Clear the terminal screen' },
  { cmd: '/reset', desc: 'Reset conversation history (start fresh)' },
  { cmd: '/status', desc: 'Show current Git status and model status' },
  { cmd: '/model', desc: 'Change active LLM model' },
  { cmd: '/sandbox', desc: 'Toggle sandboxing of execute_bash (bwrap)' },
  { cmd: '/review', desc: 'Run adversarial code review on active diff' },
  { cmd: '/review-diff', desc: 'Review the full diff and accept or discard it' },
  { cmd: '/explain', desc: 'Explain a file or code section' },
  { cmd: '/fix', desc: 'Fix a bug or error in the codebase' },
  { cmd: '/tests', desc: 'Write or run tests for a target' },
  { cmd: '/index', desc: 'Build the semantic search index' },
  { cmd: '/gh', desc: 'Run a GitHub CLI command (pr/issue/comment)' },
  { cmd: '/permissions', desc: 'Reload and show permission rules' },
  { cmd: '/agents', desc: 'List available sub-agents' },
  { cmd: '/mcp', desc: 'List configured MCP servers' },
  { cmd: '/share', desc: 'Export the current session to a file or gist' },
  { cmd: '/lsp', desc: 'Run LSP diagnostics on a file' },
  { cmd: '/plugins', desc: 'List loaded plugins' },
  { cmd: '/compact', desc: 'Manually compact the conversation context' },
  { cmd: '/init', desc: 'Bootstrap MEMORY.md from the repo structure' },
  { cmd: '/memory', desc: 'View or edit MEMORY.md' },
  { cmd: '/context', desc: 'Show a detailed context-window breakdown' },
  { cmd: '/rewind', desc: 'Undo the conversation to an earlier point' },
  { cmd: '/add-dir', desc: 'Add a directory to the allowed workspace paths' },
  { cmd: '/doctor', desc: 'Run an environment health check' },
  { cmd: '/config', desc: 'View or edit the config file' },
  { cmd: '/version', desc: 'Show the version' },
  { cmd: '/update', desc: 'Self-update' },
  { cmd: '/cost', desc: 'Show token usage and cost for this session' },
  { cmd: '/login', desc: 'Set cloud credentials' },
  { cmd: '/logout', desc: 'Clear cloud credentials' },
  { cmd: '/statusline', desc: 'Show the status line' },
  { cmd: '/apply', desc: 'Apply a patch file' },
  { cmd: '/fork', desc: 'Fork a new session off the current one' },
  { cmd: '/audit', desc: 'Show the tool-call audit log' },
  { cmd: '/vuln', desc: 'Scan the workspace for security vulnerabilities (defensive)' },
  { cmd: '/repro', desc: 'Replay a captured request to reproduce a bug' },
  { cmd: '/dream', desc: 'Consolidate session history into MEMORY.md' },
  { cmd: '/exit', desc: 'Exit the runtime' },
  { cmd: '/quit', desc: 'Exit the runtime' },
];

// Merge user-defined custom commands from config into the autocomplete list.
const customCommands = loadCustomCommands();
for (const cc of customCommands) {
  commands.push({ cmd: '/' + cc.name, desc: cc.description });
}

// ─── Clipboard helper (used by /paste) ─────────────────────────────────────
// Reads clipboard text cross-platform. Returns "" when no clipboard tool is
// available or the clipboard is empty. Uses execFileSync (no shell) so the
// clipboard content is never interpreted by a shell, and tries each tool in
// order so Wayland-first Linux setups fall back to X11 tools cleanly.
function readClipboard(): string {
  const attempts: { cmd: string; args: string[] }[] = [];
  if (process.platform === "darwin") {
    attempts.push({ cmd: "pbpaste", args: [] });
  } else if (process.platform === "win32") {
    attempts.push({ cmd: "powershell", args: ["-NoProfile", "-Command", "Get-Clipboard"] });
  } else {
    // Linux: try Wayland first, then X11 tools.
    attempts.push(
      { cmd: "wl-paste", args: ["--no-newline"] },
      { cmd: "xclip", args: ["-selection", "clipboard", "-o"] },
      { cmd: "xsel", args: ["-b", "-o"] }
    );
  }
  for (const { cmd, args } of attempts) {
    try {
      return execFileSync(cmd, args, { encoding: "utf-8" });
    } catch {
      // Try the next available clipboard tool.
    }
  }
  return "";
}

// ─── Streaming + Interrupt State (Ticket 1) ────────────────────────────────
let activeAbort: AbortController | null = null;
let isGenerating = false;
let globalSessionService: any = null;

// ─── Esc / Ctrl-C interrupt capture (Ticket 1) ──────────────────────────────
// Ctrl-C at the prompt exits because readline (raw mode) owns it, not our
// SIGINT handler; and Esc would never be captured at all. So we capture BOTH
// keys ourselves: a raw-mode keypress listener armed during generation (so
// Esc/Ctrl-C abort mid-stream), a SIGINT handler as a cooked-mode backstop,
// and an rl.on('SIGINT') override at the prompt so Ctrl-C clears the line
// instead of quitting. Quitting is via /exit only.
let generationInterruptListenerAttached = false;
function onInterruptKey(_str: string, key: any) {
  if (!isGenerating || !activeAbort) return;
  const isCtrlC = key && key.ctrl && key.name === "c";
  const isEsc = key && key.name === "escape";
  if (isCtrlC || isEsc) {
    activeAbort.abort();
  }
}
function armGenerationInterrupt() {
  if (!process.stdin.isTTY) return;
  try {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    if (!generationInterruptListenerAttached) {
      process.stdin.on("keypress", onInterruptKey);
      generationInterruptListenerAttached = true;
    }
  } catch {
    // non-TTY: fall back to the SIGINT handler
  }
}
function disarmGenerationInterrupt() {
  if (!process.stdin.isTTY) return;
  try {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  } catch {
    // ignore
  }
}

// Cache of downloaded local Ollama models
let downloadedModels: string[] = [];
async function cacheLocalModels() {
  const url = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
  try {
    const res = await fetch(`${url}/api/tags`);
    if (res.ok) {
      const data: any = await res.json();
      downloadedModels = data.models?.map((m: any) => m.name) || [];
    }
  } catch (e) {
    downloadedModels = [];
  }
}

// Domain-specific autocomplete data for the injected ui.ts prompt — kept here
// rather than in ui.ts so the UI layer has no knowledge of "Ollama models".
function getModelSuggestions(query: string) {
  return downloadedModels
    .filter(name => name.toLowerCase().includes(query.toLowerCase()))
    .map(name => ({
      cmd: `/model ${name}`,
      desc: name === ollamaModelName ? 'active model' : 'local model'
    }));
}
configurePromptSuggestions({ commands, getModelSuggestions });

// ─── Agent Configuration ────────────────────────────────────────────────────

let isUsingOllama = true;
let ollamaModelName = process.env.OLLAMA_MODEL || "gemma4-coder-tuned:latest";
const ollamaBaseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
let atomicCommits = process.env.GIT_AUTO_COMMIT === "true";

// ─── Persisted model choice (Ticket 5) ─────────────────────────────────────
// The last model selected via /model (or --model) is written to the global
// config file so it survives restarts. On boot we read it back and prefer it
// over the default, so switching models isn't lost every time the CLI exits.
const configDir = path.join(process.env.HOME || process.cwd(), ".ollama-code");
const configPath = path.join(configDir, "config.json");

function loadPersistedModel(): { model: string; cloud: boolean } | null {
  const g = loadGlobal();
  if (g.model) return { model: g.model, cloud: !!g.cloud };
  return null;
}

function persistModel(model: string, cloud: boolean) {
  persistGlobal(model, cloud, isSandboxEnabled());
}

// Persist the sandbox toggle alongside the model choice so it survives restarts.
function persistSandbox(enabled: boolean) {
  const g = loadGlobal();
  persistGlobal(g.model || ollamaModelName, g.cloud ?? false, enabled);
}

// Read the persisted sandbox flag (defaults to OFF) and apply it at boot.
function loadPersistedSandbox(): boolean {
  return loadGlobal().sandbox ?? false;
}

// Parse command line arguments for custom model flag or cloud execution mode
const startArgs = process.argv.slice(2);
// True when the user passed any model/mode-related CLI arg, so we don't
// override it with the persisted model choice below.
let modelExplicitlySet = false;

// Non-interactive / mode flags (Copilot-CLI-style ergonomics).
let askPrompt: string | null = null;   // --ask <prompt>: one-shot Q&A, no tools/session
let execPrompt: string | null = null;  // --exec <prompt>: one-shot agent run, then exit
let resumeSessionId: string | null = null; // --continue / --session <id>
let verbose = false;                   // --verbose / --debug: surface ADK logs + debug dump
let tuiMode = false;                   // --tui: open the session browser before the REPL
let fullAuto = false;                 // --full-auto / --yes: skip all confirmations
let reproFile: string | null = null;  // --repro <file>: replay a captured request

if (startArgs[0] === "cloud") {
  isUsingOllama = false;
  modelExplicitlySet = true;
} else if (startArgs[0] === "code") {
  isUsingOllama = true;
  modelExplicitlySet = true;
} else {
  isUsingOllama = process.env.GEMINI_API_KEY === "ollama";
}

for (let i = 0; i < startArgs.length; i++) {
  const arg = startArgs[i];
  if (arg === "--model" && startArgs[i + 1]) {
    const val = startArgs[i + 1];
    if (val === "cloud" || val === "gemini") {
      isUsingOllama = false;
    } else {
      ollamaModelName = val;
      isUsingOllama = true;
    }
    modelExplicitlySet = true;
    i++;
  } else if (arg === "--cloud" || arg === "cloud") {
    isUsingOllama = false;
    modelExplicitlySet = true;
  } else if (arg === "--code" || arg === "code") {
    isUsingOllama = true;
    modelExplicitlySet = true;
  } else if (arg === "--ask" && startArgs[i + 1]) {
    askPrompt = startArgs[i + 1];
    i++;
  } else if (arg === "--exec" && startArgs[i + 1]) {
    execPrompt = startArgs[i + 1];
    i++;
  } else if (arg === "--continue" || arg === "--session") {
    if (startArgs[i + 1] && !startArgs[i + 1].startsWith("-")) {
      resumeSessionId = startArgs[i + 1];
      i++;
    } else {
      resumeSessionId = "latest";
    }
  } else if (arg === "--verbose" || arg === "--debug") {
    verbose = true;
  } else if (arg === "--tui") {
    tuiMode = true;
  } else if (arg === "--full-auto" || arg === "--yes" || arg === "-y") {
    fullAuto = true;
  } else if (arg === "--repro" && startArgs[i + 1]) {
    reproFile = startArgs[i + 1];
    process.env.OLLAMA_CODE_REPRO = "1";
    i++;
  } else if (arg === "--atomic-commits") {
    atomicCommits = true;
  } else if (!arg.startsWith("-") && arg !== "code" && arg !== "cloud") {
    ollamaModelName = arg;
    isUsingOllama = true;
    const isCloudModel = arg.startsWith("gemini-") || arg.startsWith("claude-");
    if (isCloudModel) {
      isUsingOllama = false;
    }
    modelExplicitlySet = true;
  }
}

// --verbose / --debug: surface ADK's internal logs (default is ERROR-only).
if (verbose) {
  setLogLevel(LogLevel.INFO);
  process.env.OLLAMA_CODE_DEBUG = "1";
}

// --full-auto / --yes: skip all confirmation prompts (autonomous mode).
if (fullAuto) {
  setAutoApprove(true);
}

// If no explicit model was passed on the command line, restore the last model
// chosen via /model (or --model) from the previous run so the choice persists
// across restarts. Explicit CLI args above always win over persisted config.
if (!modelExplicitlySet) {
  const persisted = loadPersistedModel();
  if (persisted) {
    ollamaModelName = persisted.model;
    isUsingOllama = !persisted.cloud;
  }
}

// Restore the persisted sandbox toggle (defaults to OFF). If bwrap is missing,
// silently fall back to disabled rather than breaking the session.
if (loadPersistedSandbox() && isBwrapAvailable()) {
  setSandboxEnabled(true);
}

// If using cloud mode, clear the mock GEMINI_API_KEY so ADK uses real system credentials
if (!isUsingOllama && process.env.GEMINI_API_KEY === "ollama") {
  delete process.env.GEMINI_API_KEY;
}

const systemPrompts: Record<string, string> = {
  "gemma4-coder-tuned:latest": `You are an autonomous coding agent (like Claude Code) with tools: execute_bash, read_file, read_files, write_file, edit_file, list_dir, glob_files, grep_search, git_commit, git_status, git_add, git_diff, git_log, git_restore, run_background_command, get_background_output, kill_background_job, web_fetch, todo_write.
Custom tools are available for Git reads (status, diff, log) and do not require manual user confirmation. Always inspect your changes with git_status or git_diff before committing.
Use read_files to read multiple files at once. Use glob_files to find files matching patterns (e.g., **/*.ts). Use git_restore to discard uncommitted changes.
Use run_background_command to run background jobs (e.g. servers), get_background_output to inspect them, and kill_background_job to stop them.
Use web_fetch to download web content, and todo_write to track checklists in TODO.md.

Tool Semantics & Guidelines:
1. execute_bash runs a fresh shell session every time. To run a command in a subdirectory, pass the 'cwd' parameter. NEVER run the exact same command twice in a row — you already have its output, re-running it tells you nothing new and a repeated identical call will be blocked. If it succeeded, move on; if it failed, fix the cause first or try a different command.
2. read_file supports optional 'startLine' and 'endLine' parameters. Prefer reading specific file sections over reading the entire file when the file exceeds 200 lines to save context budget.
3. edit_file supports an optional 'edits' list array to apply multiple modifications in a single tool call.
4. grep_search supports regular expressions, pathspec globs, and context lines via parameter arguments.
5. You may call multiple independent tools in the same turn (e.g. reading several unrelated files, or running several independent searches) — each call is tracked separately, so parallel calls to the SAME tool are safe too. Do not call tools in parallel when a later call needs the result of an earlier one.
6. Large results (big files, huge glob/grep matches) are automatically truncated to protect your context window. If a result says truncated, narrow your query or line range rather than repeating the same call.

Workflow:
1. PLAN: Before writing code, think BRIEFLY (a few sentences) about the approach. Do not over-deliberate.
2. WRITE ONCE: Produce the COMPLETE, finished file in a SINGLE write_file call. Never write partial code, stubs, or placeholders. Always include BOTH arguments: path and the full content. Do not emit code as a markdown code block — emit it via the write_file tool call.
3. NO REWRITES: If a file already exists, never use write_file to recreate it. Use edit_file (oldText -> newText, match whitespace exactly) to change only the lines that need fixing. You can set 'dryRun: true' to preview your edits.
4. VERIFY: After writing, run the code with execute_bash. If it errors, read the error and use edit_file to fix the broken lines.
5. NO SELF-TALK IN CODE: Never put apologies, hesitation, or running commentary inside code. Comments must be useful documentation only.
6. FINISH: When the task is complete, stop calling tools and summarize what you did in plain text.

IMPORTANT: Keep your reasoning short. When you call write_file, always include the 'path' argument and the complete file in 'content'.`,
  "gemma4:12b-mlx": `You are a coding agent with tools: execute_bash, read_file, read_files, write_file, edit_file, list_dir, glob_files, grep_search, git_commit, git_status, git_add, git_diff, git_log, git_restore, run_background_command, get_background_output, kill_background_job, web_fetch, todo_write. Use tools, not narration. Write a file ONCE with write_file; edit existing files only with edit_file (supports array of edits and dryRun). execute_bash does not persist cwd (use cwd parameter). Never run the exact same command twice in a row — a repeat will be blocked; if it succeeded move on, if it failed fix the cause or try something else. Prefer read_file with startLine/endLine for files > 200 lines. Use glob_files for file search. Use git_restore to undo. Stop and summarize in plain text when done.`,
  "gemma4:12b": `You are a coding agent with tools: execute_bash, read_file, read_files, write_file, edit_file, list_dir, glob_files, grep_search, git_commit, git_status, git_add, git_diff, git_log, git_restore, run_background_command, get_background_output, kill_background_job, web_fetch, todo_write. Use tools, not narration. Write a file ONCE with write_file; edit existing files only with edit_file (supports array of edits and dryRun). execute_bash does not persist cwd (use cwd parameter). Never run the exact same command twice in a row — a repeat will be blocked; if it succeeded move on, if it failed fix the cause or try something else. Prefer read_file with startLine/endLine for files > 200 lines. Use glob_files for file search. Use git_restore to undo. Stop and summarize in plain text when done.`,
};

const cloudModelName = "gemini-2.5-flash";
const cloudPrompts: Record<string, string> = {
  "gemini-2.5-flash": `You are a senior coding agent with tools: execute_bash, read_file, read_files, write_file, edit_file, list_dir, glob_files, grep_search, git_commit, git_restore, run_background_command, get_background_output, kill_background_job, web_fetch, todo_write. Use tools to plan, write, edit, and verify code. execute_bash doesn't persist cwd (use cwd param). Never run the exact same command twice in a row — a repeat will be blocked. Prefer edit_file for existing files (supports multi-edits and dryRun). Use read_files for multi-read. Prefer read_file line range slices for files > 200 lines. Use glob_files for pattern searches. Independent tool calls (including parallel calls to the same tool) are safe and tracked separately; only sequence calls when one depends on another's result. Large results are truncated to protect context — narrow your query rather than repeating a truncated call. Be concise. Summarize in plain text when done.`,
};
const cloudParams: Record<string, { temperature: number; topP: number; topK: number; maxOutputTokens: number }> = {
  "gemini-2.5-flash": { temperature: 0.2, topP: 0.95, topK: 40, maxOutputTokens: 8192 },
};

const activeModelName = isUsingOllama ? ollamaModelName : cloudModelName;
const instruction = isUsingOllama
  ? (systemPrompts[activeModelName] ?? systemPrompts["gemma4-coder-tuned:latest"]!)
  : (cloudPrompts[activeModelName] ?? cloudPrompts[cloudModelName]!);

// NOTE: summarizerLlm is intentionally NOT used in Ollama mode.
// The TokenBasedContextCompactor + LlmSummarizer fires a SECOND concurrent Ollama
// request inside runner.runAsync, which deadlocks with the main LLM call since
// Ollama only handles one request at a time (OLLAMA_NUM_PARALLEL=1). This caused
// the infinite "Thinking..." hang. Use TruncatingContextCompactor only.

const model = isUsingOllama
  ? new OllamaLlm({ model: ollamaModelName, baseUrl: ollamaBaseUrl, onToken: streamToken })
  : cloudModelName; // ADK's default Gemini connector handles a bare string model.

let displayModelName = isUsingOllama ? ollamaModelName : cloudModelName;

// Context compactors: TruncatingContextCompactor only (no LlmSummarizer in Ollama
// mode to avoid concurrent request deadlocks). Threshold is lower for Ollama due
// to the smaller context window vs cloud models.
const contextCompactors = isUsingOllama
  ? [
      new TruncatingContextCompactor({ threshold: 30, preserveLeadingEvents: 4 }),
    ]
  : [
      new TruncatingContextCompactor({ threshold: 40, preserveLeadingEvents: 4 }),
    ];

const agentConfig: any = {
  name: "local-claude-ts",
  model: model,
  instruction,
  tools: allTools,
  contextCompactors,
};
if (!isUsingOllama && cloudParams[activeModelName]) {
  agentConfig.generateContentConfig = cloudParams[activeModelName];
}

const engineerAgent = new LlmAgent(agentConfig);
// Keep the delegate_task sub-agent in sync with the live model so it follows
// /model switches (engineerAgent.model is mutated in-place by the handler).
setDelegateModel(engineerAgent.model);
setSubAgentModel(engineerAgent.model);
engineerAgent.afterToolCallback = () => {
  // Restart spinner after tool completes (will be cleared when text arrives)
  startSpinner("Thinking...");
};

async function handleAutoCommit() {
  try {
    const isGit = await ensureGitRepository();
    if (!isGit) return;

    const status = execSync("git status --porcelain", { encoding: "utf-8" }).trim();
    if (!status) return;

    console.log(`\n  ${c.meta("⚡ Auto-Commit: Generating commit message...")}`);
    startSpinner("Thinking...");

    let diff = execSync("git diff", { encoding: "utf-8" }).trim();
    if (!diff) {
      diff = execSync("git status", { encoding: "utf-8" }).trim();
    }
    const systemPrompt = "You are a git commit message generator. Generate a concise, 1-line conventional commit message (e.g. 'feat: add folder path parsing') based on the following git diff. Return ONLY the message, no quotes, no markdown, no punctuation at the end, and no extra text.";

    const commitMsg = (await runUtilityAgent(engineerAgent.model, systemPrompt, diff || "Minor updates")).trim();
    stopSpinner();

    if (!commitMsg) {
      console.log(`  ${c.error("⚠️ Failed to generate commit message. Skipping auto-commit.")}\n`);
      return;
    }

    console.log(`  ${c.meta(`⚡ Auto-Commit: Staging and committing changes: "${commitMsg}"`)}`);
    execSync("git add -A", { stdio: "ignore" });
    execFileSync("git", ["commit", "-m", commitMsg], { stdio: "ignore" });
    console.log(`  ${c.success("✓ Auto-committed successfully!")}\n`);
  } catch (err: any) {
    stopSpinner();
    console.log(`  ${c.error(`⚠️ Auto-commit failed: ${err.message}`)}\n`);
  }
}

async function handleAdversarialReview() {
  try {
    const isGit = await ensureGitRepository();
    if (!isGit) {
      console.log(`\n  ${c.error("Error: Not inside a Git repository.")}\n`);
      return;
    }

    let diff = execSync("git diff", { encoding: "utf-8" }).trim();
    if (!diff) {
      diff = execSync("git diff --staged", { encoding: "utf-8" }).trim();
    }
    if (!diff) {
      console.log(`\n  ${c.white("No uncommitted changes detected to review.")}\n`);
      return;
    }

    console.log(`\n  ${c.meta("⚡ Launching Adversarial Code Review Swarm...")}`);
    startSpinner("Thinking...");

    const systemPrompt = `You are a highly critical, adversarial senior code reviewer (Linus Torvalds persona).
Analyze the provided git diff. Scrutinize the changes for:
- Logical bugs or logical regressions
- Syntax errors or typos
- Unhandled edge cases (null inputs, empty bounds, exceptions)
- Performance bottlenecks
- Security flaws or credential leaks

Present a concise, triaged report rating severity (Critical / Warning / Info).
Use bold highlights and standard markdown. Be extremely direct and critical.`;

    stopSpinner();
    console.log();
    console.log(c.border('─'.repeat(process.stdout.columns || 80)));
    await runUtilityAgent(engineerAgent.model, systemPrompt, diff, {
      onToken: (token) => {
        process.stdout.write(token);
      },
    });
    console.log();
    console.log(c.border('─'.repeat(process.stdout.columns || 80)));
    console.log();
  } catch (err: any) {
    stopSpinner();
    console.log(`\n  ${c.error(`Error during review: ${err.message}`)}\n`);
  }
}

// Auto-Dream sometimes produces conversational dialogue (questions to the
// user, "Shall I proceed?") instead of consolidated notes. That garbage gets
// re-injected into every future turn via getMemoryContext(), so reject it
// before it ever touches disk.
const MEMORY_DIALOGUE_PATTERNS = [
  /shall (i|we)\b/i,
  /would you like/i,
  /do you want (me|us)\b/i,
  /should i proceed/i,
  /let me know/i,
  /\bawait(ing)? (your|the user'?s) (input|approval|confirmation)/i,
  /\?\s*$/, // ends the whole file on a question directed at someone
];
function isValidMemoryContent(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length < 20) return false;
  return !MEMORY_DIALOGUE_PATTERNS.some((p) => p.test(trimmed));
}

async function handleAutoDream(sessionService: any, sessionId: string, silent = false) {
  if (!sessionId) return;
  try {
    const activeService = sessionService || globalSessionService;
    if (!activeService) return;
    const history = await activeService.getSession({ appName: "local-claude-ts", userId: "local-user", sessionId });
    if (!history || !history.events || history.events.length <= 1) {
      if (!silent) {
        console.log(`\n  ${c.white("No conversation history available to consolidate.")}\n`);
      }
      return;
    }

    if (!silent) {
      console.log(`\n  ${c.meta("⚡ Auto-Dream: Consolidating memory into MEMORY.md...")}`);
      startSpinner("Thinking...");
    }

    let existingMemory = "";
    const memoryFilePath = path.resolve("MEMORY.md");
    if (fs.existsSync(memoryFilePath)) {
      existingMemory = fs.readFileSync(memoryFilePath, "utf-8");
    }

    // Prefer the running-summary compaction output when available: it is already
    // a compact, semantic summary of the conversation that survives truncation,
    // so it fits the local model's context window even on very long sessions.
    // Fall back to the raw session history only when no summary exists yet.
    const compactedSummary = compaction.getSummary();
    const historyText = compactedSummary
      ? `(compacted running summary of the session)\n${compactedSummary}`
      : history.events
          .map((event: any) => {
            const role = event.author === "user" ? "USER" : "AGENT";
            const text = stringifyContent(event) || "";
            return `${role}: ${text}`;
          })
          .join("\n\n");

    const systemPrompt = `You are a project memory consolidation engine (Auto-Dream).
Your task is to analyze the recent conversation history and update/consolidate the persistent project memory file: MEMORY.md.

Guidelines:
1. Summarize key architectural decisions, file changes, and structural patterns.
2. Outline current progress, completed tasks, and open issues/next steps.
3. Keep the MEMORY.md file clean, highly organized, and capped at an efficient 200 lines.
4. Merge recent insights into the existing memory structure without deleting critical old knowledge.
5. Return ONLY the complete, raw markdown content for the MEMORY.md file. No markdown code blocks surrounding the output, no talking.
6. This file is read back into your own context on every future turn — it is a private note to yourself, not a message to the user. Never address the user directly, ask a question, or propose next steps for them to approve (no "Shall I...", "Would you like...", or trailing questions). State facts and decisions only.

Note: The "Recent History" below may be a compacted running summary rather than the verbatim transcript. Treat it as authoritative — it already preserves the important facts, decisions, and current state of the work.`;

    const userPrompt = `Existing Memory:\n${existingMemory}\n\nRecent History:\n${historyText}`;

    const consolidatedMemory = (await runUtilityAgent(engineerAgent.model, systemPrompt, userPrompt)).trim();

    if (!isValidMemoryContent(consolidatedMemory)) {
      if (!silent) {
        stopSpinner();
        console.log(`\n  ${c.warn("⚠️ Auto-Dream produced dialogue instead of notes — discarding, MEMORY.md left unchanged.")}\n`);
      }
      return;
    }

    fs.writeFileSync(memoryFilePath, consolidatedMemory, "utf-8");

    if (!silent) {
      stopSpinner();
      console.log(`  ${c.success("✓ Successfully consolidated memory into MEMORY.md!")}\n`);
    }
  } catch (err: any) {
    if (!silent) {
      stopSpinner();
      console.log(`\n  ${c.error(`Error during memory consolidation: ${err.message}`)}\n`);
    }
  }
}

function getMemoryContext(): string {
  let memoryText = "";
  const memoryFilePath = path.resolve("MEMORY.md");
  if (fs.existsSync(memoryFilePath)) {
    try {
      const content = fs.readFileSync(memoryFilePath, "utf-8").trim();
      if (content) {
        memoryText = `\n\n---\nPROJECT MEMORY (MEMORY.md):\n${content}\n---`;
      }
    } catch (err) {
      // Ignore
    }
  }
  const scratchpadText = scratchpad.getContextPrompt();
  const compactionText = compaction.getContextPrompt();
  return memoryText
    + (scratchpadText ? `\n${scratchpadText}` : "")
    + (compactionText ? `\n${compactionText}` : "");
}

// ─── Main Loop ──────────────────────────────────────────────────────────────

async function main() {
  printWelcomeBanner({ displayModelName, isUsingOllama });
  await cacheLocalModels();

  // --repro <file>: replay a captured request and exit (no REPL).
  if (reproFile) {
    try {
      console.log(`\n  ${c.meta(`⚡ Replaying captured request from ${reproFile}...`)}`);
      const result = await replayRepro(reproFile, ollamaBaseUrl);
      console.log();
      process.stdout.write(result);
      console.log();
    } catch (err: any) {
      console.error(`\n  ${c.error(`Replay failed: ${err.message}`)}\n`);
      process.exit(1);
    }
    process.exit(0);
  }

  // Load MCP server tools (if any are configured) and merge them into the
  // agent's toolset. Non-fatal: if none are configured or all fail, the agent
  // just runs with the built-in tools.
  const mcpTools = await loadMcpTools();
  if (mcpTools.length > 0) {
    engineerAgent.tools = [...allTools, ...mcpTools];
    console.log(`  ${c.meta(`🔌 Loaded ${mcpTools.length} MCP tool(s) from ${listMcpServers().join(", ")}`)}`);
  }

  // Resolve the real context window for the active Ollama model so the
  // context-% footer reflects what's actually loaded (not a hardcoded guess).
  if (isUsingOllama && model instanceof OllamaLlm) {
    await model.refreshContextWindow();
  }


  // Persistent session store (Ticket 2): SQLite at ~/.ollama-code/sessions.db.
  // @mikro-orm/sqlite is already installed (transitive of @google/adk), so this
  // works with no new `npm install`. Conversation history survives restart.
  const sessionDbPath = path.join(process.env.HOME || process.cwd(), ".ollama-code", "sessions.db");
  fs.mkdirSync(path.dirname(sessionDbPath), { recursive: true });
  // Pass a sqlite:// connection string — DatabaseSessionService.init() resolves
  // the MikroORM driver from the URI. (The options-object path would require a
  // `driver` class, which is fiddlier; the URI path is the documented easy path.)
  const sessionService = new DatabaseSessionService(`sqlite://${sessionDbPath}`);
  await sessionService.init();
  globalSessionService = sessionService;

  const runner = new Runner({
    agent: engineerAgent,
    appName: engineerAgent.name,
    sessionService,
  });

  // Resume a session: --session <id> / --continue <id> for a specific one,
  // --continue (no arg) for the most recent, else the most recent by default.
  let session;
  try {
    const listed = await sessionService.listSessions({ appName: runner.appName, userId: "local-user" });

    // --tui: open the interactive session browser to pick a session.
    if (tuiMode && !resumeSessionId) {
      const sessions = (listed.sessions || []).map((s: any) => ({
        id: s.id,
        title: s.title || s.id,
      }));
      const picked = await sessionBrowser(sessions);
      if (picked) {
        session = await sessionService.getSession({ appName: runner.appName, userId: "local-user", sessionId: picked });
      }
    }

    if (!session) {
      if (resumeSessionId && resumeSessionId !== "latest") {
        session = await sessionService.getSession({ appName: runner.appName, userId: "local-user", sessionId: resumeSessionId });
      } else {
        const recent = listed.sessions?.[0];
        session = recent
          ? await sessionService.getSession({ appName: runner.appName, userId: "local-user", sessionId: recent.id })
          : undefined;
      }
    }
  } catch (e) {
    session = undefined;
  }
  if (!session) {
    session = await sessionService.createSession({ appName: runner.appName, userId: "local-user" });
  }

  // Ctrl-C interrupt (Ticket 1): cooked-mode backstop. During generation we
  // abort the in-flight run and return to the prompt. The primary interrupt
  // path is the Esc/Ctrl-C keypress capture armed in armGenerationInterrupt()
  // (raw mode), since at the prompt readline owns Ctrl-C. Quitting is via
  // /exit only — Ctrl-C never quits the CLI on its own.
  process.on("SIGINT", () => {
    if (isGenerating && activeAbort) {
      activeAbort.abort();
    }
    // Else: ignore. /exit is the way out.
  });

  // ─── One-shot modes (--ask / --exec) ─────────────────────────────────────
  // --ask: a single Q&A with no tools and no session persistence (like Copilot
  // CLI's --ask). --exec: a single autonomous agent run (full toolset) that
  // exits when done. Both print the result and return without entering the REPL.
  if (askPrompt !== null || execPrompt !== null) {
    const prompt = askPrompt ?? execPrompt!;
    const isAsk = askPrompt !== null;
    if (isAsk) {
      const answer = await runUtilityAgent(engineerAgent.model, "You are a helpful assistant. Answer the user's question concisely and accurately.", prompt);
      console.log();
      console.log(c.border('─'.repeat(process.stdout.columns || 80)));
      process.stdout.write(renderMarkdown(answer));
      console.log();
      console.log(c.border('─'.repeat(process.stdout.columns || 80)));
      console.log();
    } else {
      const gitContext = await getGitContext();
      const memoryContext = getMemoryContext();
      const fullPrompt = `${gitContext}${memoryContext}\n\nUser request: ${prompt}`;
      activeAbort = new AbortController();
      isGenerating = true;
      beginStream();
      armGenerationInterrupt();
      try {
        for await (const event of runner.runAsync({
          userId: session.userId,
          sessionId: session.id,
          newMessage: { role: "user", parts: [{ text: fullPrompt }] },
          abortSignal: activeAbort.signal,
          runConfig: { maxLlmCalls: 60 },
        })) {
          if (activeAbort.signal.aborted) break;
          if (event.content && event.content.parts) {
            const text = event.content.parts
              .filter((part: any) => part.text)
              .map((part: any) => part.text)
              .join("");
            if (text) {
              if (stream.buffer && (text === stream.buffer || stream.buffer.endsWith(text) || text.endsWith(stream.buffer))) {
                stream.buffer = "";
              } else {
                stopSpinner();
                stream.buffer = "";
                process.stdout.write(renderMarkdown(text));
              }
            }
          }
        }
        stopSpinner();
        if (stream.emittedNewline) process.stdout.write('\n');
        console.log();
      } catch (err: any) {
        stopSpinner();
        console.log(`\n  ${c.error(`Error: ${err.message}`)}\n`);
      } finally {
        disarmGenerationInterrupt();
        isGenerating = false;
        endStream();
        activeAbort = null;
      }
    }
    killAllBackgroundJobs();
    closeMcpConnections().catch(() => {});
    closeLspClients();
    process.exit(0);
  }

  let turnNumber = 0;
  while (true) {
    turnNumber++;
    console.log(c.border('─'.repeat(process.stdout.columns || 80)));
    let userInput = await promptInput(`${c.prompt('❯')} `);


    if (!userInput.trim()) continue;

    // Reset tool call history for this user turn to prevent loop guard state carryover
    resetLoopGuard();

    // Local Slash Commands Handler
    if (userInput.trim().startsWith("/")) {
      const parts = userInput.trim().split(/\s+/);
      const command = parts[0].toLowerCase();

      if (command === "/exit" || command === "/quit") {
        console.log(`\n  ${c.dim('Goodbye.')}\n`);
        killAllBackgroundJobs();
        // Explicit exit: the persistent SQLite session service (MikroORM) holds
        // an open DB handle that keeps the event loop alive, so a plain break
        // out of main() would no longer terminate the process.
        process.exit(0);
      } else if (command === "/clear") {
        console.clear();
        continue;
      } else if (command === "/help") {
        printHelp();
        continue;
      } else if (command === "/paste") {
        const clipboardText = readClipboard();
        const trimmed = clipboardText.trim();

        if (!trimmed) {
          console.log(`\n  ${c.error("Clipboard is empty or no clipboard tool is available.")}\n`);
          continue;
        }

        console.log(`\n  ${c.success(`✓ Pasted ${trimmed.split('\n').length} lines from clipboard:`)}`);
        console.log(c.dim(trimmed));
        console.log();

        userInput = trimmed;
      } else if (command === "/reset") {
        session = await runner.sessionService.createSession({
          appName: runner.appName,
          userId: "local-user",
        });
        console.log(`\n  ${c.success("✓ Conversation history reset.")}\n`);
        continue;
      } else if (command === "/model") {
        const modelArg = parts[1];
        if (!modelArg) {
          // List available local models
          try {
            const res = await fetch(`${ollamaBaseUrl}/api/tags`);
            if (res.ok) {
              const data: any = await res.json();
              const names = data.models?.map((m: any) => m.name) || [];
              console.log(`\n  ${c.bold('Downloaded Ollama Models:')}`);
              names.forEach((name: string) => {
                const active = name === ollamaModelName ? ` ${c.success('(active)')}` : '';
                console.log(`  - ${c.white(name)}${active}`);
              });
              console.log(`\n  ${c.dim('Tip: Type /model <name> to switch models.')}\n`);
            } else {
              console.log(`\n  ${c.error('Failed to retrieve Ollama models.')}\n`);
            }
          } catch (e) {
            console.log(`\n  ${c.error('Ollama server is not running or unreachable.')}\n`);
          }
        } else {
          // Switch to the specified model (Ticket 4): mutate model, instruction,
          // and (for cloud) generateContentConfig on the live agent. Conversation
          // history is preserved (same session).
          const isCloud = modelArg.startsWith("gemini-") || modelArg.startsWith("claude-");
          if (isCloud) {
            engineerAgent.model = modelArg; // ADK default connector for the bare string
            engineerAgent.instruction = cloudPrompts[modelArg] ?? cloudPrompts[cloudModelName]!;
            engineerAgent.generateContentConfig = cloudParams[modelArg] ?? cloudParams[cloudModelName];
setDelegateModel(engineerAgent.model);
setSubAgentModel(engineerAgent.model);
            ollamaModelName = modelArg;
            displayModelName = modelArg;
            // Flip to cloud mode at runtime: clear the mock key so ADK uses real
            // credentials, mirroring the startup-time cloud-mode handling.
            isUsingOllama = false;
            if (process.env.GEMINI_API_KEY === "ollama") delete process.env.GEMINI_API_KEY;
            persistModel(modelArg, true);
            console.log(`\n  ${c.success(`✓ Switched to cloud model: ${modelArg}`)}\n`);
          } else {
            ollamaModelName = modelArg;
            displayModelName = modelArg;
            isUsingOllama = true;
            const newModel = new OllamaLlm({ model: ollamaModelName, baseUrl: ollamaBaseUrl, onToken: streamToken });
            engineerAgent.model = newModel;
            setDelegateModel(newModel);
            setSubAgentModel(newModel);
            // Resolve the new model's real context window for the footer.
            await newModel.refreshContextWindow();
            engineerAgent.instruction = systemPrompts[ollamaModelName] ?? systemPrompts["gemma4-coder-tuned:latest"]!;
            // Clear any cloud generateContentConfig so local sampling (per-model
            // params inside OllamaLlm) applies.
            engineerAgent.generateContentConfig = undefined;
            persistModel(ollamaModelName, false);
            console.log(`\n  ${c.success(`✓ Switched active model to: ${ollamaModelName}`)}\n`);
          }
        }
        continue;
      } else if (command === "/sandbox") {
        // Toggle sandboxing of execute_bash. When enabled, shell commands run
        // inside bwrap: network blocked, filesystem confined to the workspace.
        // The choice is persisted so it survives restarts.
        const arg = parts[1]?.toLowerCase();
        let next: boolean;
        if (arg === "on" || arg === "true" || arg === "1") next = true;
        else if (arg === "off" || arg === "false" || arg === "0") next = false;
        else next = !isSandboxEnabled();

        if (next && !isBwrapAvailable()) {
          console.log(`\n  ${c.error("Sandboxing requires bubblewrap (bwrap), which is not installed on this system.")}\n`);
          continue;
        }

        setSandboxEnabled(next);
        persistSandbox(next);
        console.log(`\n  ${c.success(`✓ Sandboxing ${next ? "ENABLED" : "disabled"}.`)} ${next ? c.dim("execute_bash is now confined to the workspace with network blocked.") : ""}\n`);
        continue;
      } else if (command === "/status") {
        printStatus({ displayModelName, isUsingOllama, ollamaBaseUrl, gitSummaryLine: (await getGitContext()).split('\n')[0] });
        continue;
      } else if (command === "/review" || command === "/code-review") {
        await handleAdversarialReview();
        continue;
      } else if (command === "/review-diff") {
        // Batch diff review gate: show the full uncommitted diff and let the
        // user accept (keep) or reject (git restore) the changes.
        try {
          const isGit = await ensureGitRepository();
          if (!isGit) {
            console.log(`\n  ${c.error("Error: Not inside a Git repository.")}\n`);
            continue;
          }
          let diff = execSync("git diff", { encoding: "utf-8" }).trim();
          if (!diff) diff = execSync("git diff --staged", { encoding: "utf-8" }).trim();
          if (!diff) {
            console.log(`\n  ${c.white("No uncommitted changes to review.")}\n`);
            continue;
          }
          console.log();
          console.log(c.border('─'.repeat(process.stdout.columns || 80)));
          process.stdout.write(renderMarkdown("```diff\n" + diff + "\n```"));
          console.log();
          console.log(c.border('─'.repeat(process.stdout.columns || 80)));
          console.log();
          const keep = await confirmAction("Keep these changes? (No discards them via git restore)");
          if (!keep) {
            execSync("git restore .", { stdio: "ignore" });
            console.log(`  ${c.success("✓ Discarded uncommitted changes.")}\n`);
          } else {
            console.log(`  ${c.success("✓ Changes kept.")}\n`);
          }
        } catch (err: any) {
          console.log(`\n  ${c.error(`Error during diff review: ${err.message}`)}\n`);
        }
        continue;
      } else if (command === "/index") {
        console.log(`\n  ${c.meta("⚡ Building semantic search index...")}`);
        startSpinner("Indexing...");
        const status = await buildIndex(ollamaBaseUrl);
        stopSpinner();
        console.log(`  ${c.success(`✓ ${status}`)}\n`);
        continue;
      } else if (command === "/mcp") {
        const sub = parts[1]?.toLowerCase();
        if (sub === "add") {
          // /mcp add <name> <command> [args...]
          const name = parts[2];
          const cmd = parts[3];
          if (!name || !cmd) {
            console.log(`\n  ${c.dim("Usage: /mcp add <name> <command> [args...]  — adds an MCP server to config.")}\n`);
            continue;
          }
          const cfgPath = path.join(process.cwd(), ".ollama-code.json");
          let cfg: any = {};
          try { if (fs.existsSync(cfgPath)) cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8")); } catch { /* ignore */ }
          cfg.mcpServers = cfg.mcpServers || {};
          cfg.mcpServers[name] = { command: cmd, args: parts.slice(4) };
          fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf-8");
          console.log(`  ${c.success(`✓ Added MCP server "${name}". Restart to load its tools.`)}\n`);
          continue;
        } else if (sub === "remove") {
          const name = parts[2];
          if (!name) {
            console.log(`\n  ${c.dim("Usage: /mcp remove <name>  — removes an MCP server from config.")}\n`);
            continue;
          }
          const cfgPath = path.join(process.cwd(), ".ollama-code.json");
          let cfg: any = {};
          try { if (fs.existsSync(cfgPath)) cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8")); } catch { /* ignore */ }
          if (cfg.mcpServers && cfg.mcpServers[name]) {
            delete cfg.mcpServers[name];
            fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf-8");
            console.log(`  ${c.success(`✓ Removed MCP server "${name}".`)}\n`);
          } else {
            console.log(`  ${c.error(`No MCP server named "${name}".`)}\n`);
          }
          continue;
        }
        const servers = listMcpServers();
        if (servers.length === 0) {
          console.log(`\n  ${c.dim("No MCP servers configured. Use /mcp add <name> <command> [args...].")}\n`);
        } else {
          console.log(`\n  ${c.bold("Configured MCP Servers:")}`);
          for (const s of servers) console.log(`  - ${c.white(s)}`);
          console.log(`\n  ${c.dim("Use /mcp add <name> <command> [args...] or /mcp remove <name>.")}\n`);
        }
        continue;
      } else if (command === "/agents") {
        const custom = reloadSubAgents();
        console.log(`\n  ${c.bold("Available Sub-Agents:")}`);
        for (const a of listSubAgents()) {
          console.log(`  - ${c.white(a.name)}${a.tools ? c.dim(` [tools: ${a.tools.join(", ")}]`) : ""}`);
          console.log(`    ${c.dim(a.description)}`);
        }
        console.log(`\n  ${c.dim(`(${custom} custom agent(s) from config)`)}\n`);
        continue;
      } else if (command === "/permissions") {
        const source = reloadPermissions();
        console.log(`\n  ${c.meta("Permission rules reloaded.")}${source ? c.dim(` (from ${source})`) : c.dim(" (no config file found — all tools ask)")}`);
        console.log(`  ${c.dim("Example: create .ollama-code.json with { \"permissions\": { \"allow\": [\"git_status\"], \"deny\": [\"execute_bash:rm -rf\"] } }")}\n`);
        continue;
      } else if (command === "/gh") {
        // Pass through to the gh CLI: /gh pr list, /gh issue create --title ...
        const ghArgs = parts.slice(1);
        if (ghArgs.length === 0) {
          console.log(`\n  ${c.dim("Usage: /gh <gh args>  e.g. /gh pr list, /gh issue list")}\n`);
          continue;
        }
        try {
          const { execFileSync } = await import("child_process");
          const out = execFileSync("gh", ghArgs, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
          console.log();
          process.stdout.write(out);
          console.log();
        } catch (err: any) {
          console.log(`\n  ${c.error(`gh failed: ${err.stderr || err.message}`)}\n`);
        }
        continue;
      } else if (command === "/explain" || command === "/fix" || command === "/tests") {
        // Intent commands: run a focused utility-agent pass over the target.
        const target = parts.slice(1).join(" ") || ".";
        const intent = command.slice(1); // explain | fix | tests
        const systemPrompt = {
          explain: `You are a code explainer. Given a file path or code section, explain what it does, its key functions, and how it fits together. Be concise and structured.`,
          fix: `You are a debugging agent. Given a bug or error description, investigate the relevant code (use read_file/grep_search), identify the root cause, and apply a minimal fix with edit_file. Verify with execute_bash if possible. Report what you changed.`,
          tests: `You are a test-writing agent. Given a target (file or feature), write appropriate tests for it following the project's existing test conventions. Use read_file to understand the code, then write the test file. Report what you created.`,
        }[intent];
        const gitContext = await getGitContext();
        const memoryContext = getMemoryContext();
        const userPrompt = `${gitContext}${memoryContext}\n\nTask: ${target}`;
        console.log(`\n  ${c.meta(`⚡ Running /${intent} on: ${target}`)}`);
        startSpinner("Thinking...");
        try {
          const result = await runUtilityAgent(engineerAgent.model, systemPrompt, userPrompt, {
            tools: allTools,
            onToken: (t) => process.stdout.write(t),
          });
          stopSpinner();
          console.log();
          if (!result.trim()) console.log(`  ${c.warn("(no output)")}`);
        } catch (err: any) {
          stopSpinner();
          console.log(`\n  ${c.error(`Error during /${intent}: ${err.message}`)}\n`);
        }
        continue;
      } else if (command === "/share") {
        // Export the current session to a local file or a GitHub gist.
        try {
          const history = await sessionService.getSession({ appName: "local-claude-ts", userId: "local-user", sessionId: session.id });
          const events = history?.events || [];
          if (events.length === 0) {
            console.log(`\n  ${c.white("No conversation history to share.")}\n`);
            continue;
          }
          const target = parts[1]?.toLowerCase();
          if (target === "gist") {
            console.log(`\n  ${c.meta("⚡ Posting session to GitHub gist...")}`);
            startSpinner("Sharing...");
            try {
              const url = await exportToGist(events);
              stopSpinner();
              console.log(`  ${c.success(`✓ Shared: ${url}`)}\n`);
            } catch (err: any) {
              stopSpinner();
              console.log(`  ${c.error(`Gist failed: ${err.message}`)}\n`);
            }
          } else {
            const file = exportToFile(events);
            console.log(`  ${c.success(`✓ Exported session to ${file}`)}\n`);
          }
        } catch (err: any) {
          console.log(`\n  ${c.error(`Error sharing session: ${err.message}`)}\n`);
        }
        continue;
      } else if (command === "/lsp") {
        // Run LSP diagnostics on a file (or the current diff's files).
        const target = parts[1];
        if (!target) {
          console.log(`\n  ${c.dim("Usage: /lsp <file>  (requires an LSP server configured in .ollama-code.json)")}\n`);
          continue;
        }
        const fullPath = path.resolve(target);
        if (!fs.existsSync(fullPath)) {
          console.log(`\n  ${c.error(`File not found: ${target}`)}\n`);
          continue;
        }
        console.log(`\n  ${c.meta(`⚡ Running LSP diagnostics on ${target}...`)}`);
        startSpinner("Analyzing...");
        const diags = await lspDiagnostics(fullPath);
        stopSpinner();
        if (diags.length === 0) {
          console.log(`  ${c.success("✓ No diagnostics reported.")}\n`);
        } else {
          for (const d of diags) {
            const sev = d.severity === "Error" ? c.error(d.severity) : c.warn(d.severity);
            console.log(`  ${sev} ${d.file}:${d.line} — ${d.message}`);
          }
          console.log();
        }
        continue;
      } else if (command === "/plugins") {
        const n = reloadPlugins();
        if (n === 0) {
          console.log(`\n  ${c.dim("No plugins configured. Add a \"plugins\" block to .ollama-code.json.")}\n`);
        } else {
          console.log(`\n  ${c.bold("Loaded Plugins:")}`);
          for (const p of listPlugins()) {
            const hooksList = Object.keys(p.hooks).filter((h) => (p.hooks as any)[h]).join(", ");
            console.log(`  - ${c.white(p.name)}${hooksList ? c.dim(` [hooks: ${hooksList}]`) : ""}`);
          }
          console.log();
        }
        continue;
      } else if (command === "/compact") {
        // Manual context compaction: summarize the current history into the
        // running summary (same path as the auto-compaction, but on demand).
        try {
          const history = await sessionService.getSession({ appName: "local-claude-ts", userId: "local-user", sessionId: session.id });
          const events = history?.events || [];
          if (events.length === 0) {
            console.log(`\n  ${c.white("No conversation history to compact.")}\n`);
            continue;
          }
          const historyText = events
            .map((event: any) => {
              const role = event.author === "user" ? "USER" : "AGENT";
              const text = stringifyContent(event) || "";
              return `${role}: ${text}`;
            })
            .join("\n\n");
          console.log(`\n  ${c.meta("⚡ Compacting conversation context...")}`);
          startSpinner("Compacting...");
          await compaction.refresh(engineerAgent.model, historyText, turnNumber + 1);
          stopSpinner();
          const summary = compaction.getSummary();
          if (summary) {
            console.log(`  ${c.success(`✓ Context compacted (${summary.length} chars of summary).`)}`);
            console.log(`  ${c.dim("The summary will be injected into the next turn's context.")}\n`);
          } else {
            console.log(`  ${c.warn("Compaction produced no summary — context unchanged.")}\n`);
          }
        } catch (err: any) {
          stopSpinner();
          console.log(`\n  ${c.error(`Error during compaction: ${err.message}`)}\n`);
        }
        continue;
      } else if (command === "/init") {
        // Bootstrap MEMORY.md from the repo structure.
        try {
          const memoryFilePath = path.resolve("MEMORY.md");
          if (fs.existsSync(memoryFilePath)) {
            console.log(`\n  ${c.warn("MEMORY.md already exists. Use /dream to update it, or delete it first to re-init.")}\n`);
            continue;
          }
          const gitContext = await getGitContext();
          const files = await new Promise<string[]>((resolve) => {
            const { execFile } = require("child_process");
            execFile("git", ["ls-files"], { encoding: "utf-8" }, (err: any, out: string) => {
              resolve(err ? [] : out.split("\n").filter(Boolean).slice(0, 200));
            });
          });
          const systemPrompt = `You are a project memory initializer. Based on the repository structure and git state below, create an initial MEMORY.md that captures: what the project is, its architecture, key files, and how to run/test it. Return ONLY the complete markdown content. Do not address the user or ask questions.`;
          const userPrompt = `${gitContext}\n\nTracked files:\n${files.join("\n")}`;
          console.log(`\n  ${c.meta("⚡ Initializing MEMORY.md from repo structure...")}`);
          startSpinner("Analyzing...");
          const content = (await runUtilityAgent(engineerAgent.model, systemPrompt, userPrompt)).trim();
          stopSpinner();
          if (!content || content.length < 20) {
            console.log(`  ${c.warn("Initialization produced no useful content — MEMORY.md not written.")}\n`);
            continue;
          }
          fs.writeFileSync(memoryFilePath, content, "utf-8");
          console.log(`  ${c.success("✓ Created MEMORY.md")}\n`);
        } catch (err: any) {
          stopSpinner();
          console.log(`\n  ${c.error(`Error during init: ${err.message}`)}\n`);
        }
        continue;
      } else if (command === "/memory") {
        // View or edit MEMORY.md.
        const memoryFilePath = path.resolve("MEMORY.md");
        if (!fs.existsSync(memoryFilePath)) {
          console.log(`\n  ${c.white("No MEMORY.md yet. Use /init to create one.")}\n`);
          continue;
        }
        const content = fs.readFileSync(memoryFilePath, "utf-8");
        if (parts[1] === "edit") {
          console.log(`\n  ${c.dim("Opening MEMORY.md in your default editor...")}`);
          const { execFile } = require("child_process");
          const editor = process.env.EDITOR || "vi";
          execFile(editor, [memoryFilePath], { stdio: "inherit" }, () => {
            console.log(`  ${c.success("✓ MEMORY.md updated.")}\n`);
          });
        } else {
          console.log();
          console.log(c.border('─'.repeat(process.stdout.columns || 80)));
          process.stdout.write(content);
          console.log();
          console.log(c.border('─'.repeat(process.stdout.columns || 80)));
          console.log(`  ${c.dim("Use /memory edit to open it in your editor.")}\n`);
        }
        continue;
      } else if (command === "/context") {
        // Detailed context-window breakdown.
        const liveModel = engineerAgent.model;
        let window = 8192;
        if (liveModel instanceof OllamaLlm) {
          window = liveModel.getContextWindow();
        }
        const { usage } = getUsage();
        const used = usage.totalTokens;
        const pct = window > 0 ? Math.min(100, Math.round((used / window) * 100)) : 0;
        const barWidth = Math.max(10, (process.stdout.columns || 80) - 20);
        const filled = Math.round((pct / 100) * barWidth);
        const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
        console.log(`\n  ${c.bold("Context Window:")}`);
        console.log(`  ${c.dim("Model:")}   ${c.white(displayModelName)}`);
        console.log(`  ${c.dim("Window:")}  ${c.white(String(window))} tokens`);
        console.log(`  ${c.dim("Used:")}    ${c.white(String(used))} tokens (${pct}%)`);
        console.log(`  ${c.dim("Free:")}    ${c.white(String(Math.max(0, window - used)))} tokens`);
        console.log(`  ${c.meta(bar)}`);
        console.log(`  ${c.dim("Memory (MEMORY.md) + scratchpad + compaction summary are injected each turn.")}\n`);
        continue;
      } else if (command === "/rewind") {
        // Undo the conversation to an earlier point. We delete the current
        // session and create a fresh one (a full checkpoint restore would
        // require snapshotting events; this is a pragmatic reset).
        const n = parts[1] ? parseInt(parts[1], 10) : 1;
        if (isNaN(n) || n < 1) {
          console.log(`\n  ${c.dim("Usage: /rewind [n]  — discards the last n turns and starts fresh.")}\n`);
          continue;
        }
        const confirmed = await confirmAction(`Discard the last ${n} turn(s) and start fresh?`);
        if (!confirmed) {
          console.log(`  ${c.dim("Rewind cancelled.")}\n`);
          continue;
        }
        try {
          await sessionService.deleteSession({ appName: runner.appName, userId: "local-user", sessionId: session.id });
        } catch (e) { /* ignore */ }
        session = await sessionService.createSession({ appName: runner.appName, userId: "local-user" });
        compaction.reset();
        resetUsage();
        console.log(`  ${c.success(`✓ Rewound. Started a fresh session (${session.id}).`)}\n`);
        continue;
      } else if (command === "/add-dir") {
        // Add a directory to the allowed workspace paths at runtime.
        const dir = parts[1];
        if (!dir) {
          console.log(`\n  ${c.dim("Usage: /add-dir <path>  — adds a directory to the allowed workspace paths.")}\n`);
          continue;
        }
        const abs = path.resolve(dir);
        if (!fs.existsSync(abs)) {
          console.log(`\n  ${c.error(`Directory does not exist: ${dir}`)}\n`);
          continue;
        }
        // Persist to the project config so it survives restarts.
        const cfgPath = path.join(process.cwd(), ".ollama-code.json");
        let cfg: any = {};
        try { if (fs.existsSync(cfgPath)) cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8")); } catch { /* ignore */ }
        cfg.workspaceDirs = cfg.workspaceDirs || [];
        if (!cfg.workspaceDirs.includes(abs)) cfg.workspaceDirs.push(abs);
        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf-8");
        console.log(`  ${c.success(`✓ Added ${abs} to allowed workspace paths.`)}\n`);
        continue;
      } else if (command === "/doctor") {
        console.log(`\n  ${c.bold("Environment Health Check:")}`);
        const checks = await runHealthChecks(ollamaBaseUrl);
        for (const chk of checks) {
          const icon = chk.ok ? c.success("✓") : c.error("✗");
          console.log(`  ${icon} ${c.white(chk.label)}: ${c.dim(chk.detail)}`);
        }
        console.log();
        continue;
      } else if (command === "/config") {
        const cfgPath = path.join(process.cwd(), ".ollama-code.json");
        if (parts[1] === "edit") {
          if (!fs.existsSync(cfgPath)) fs.writeFileSync(cfgPath, "{}", "utf-8");
          console.log(`\n  ${c.dim("Opening config in your default editor...")}`);
          const { execFile } = require("child_process");
          const editor = process.env.EDITOR || "vi";
          execFile(editor, [cfgPath], { stdio: "inherit" }, () => {
            console.log(`  ${c.success("✓ Config updated. Reload with /permissions, /agents, /plugins.")}\n`);
          });
        } else {
          if (!fs.existsSync(cfgPath)) {
            console.log(`\n  ${c.white("No .ollama-code.json yet. Use /config edit to create one.")}\n`);
          } else {
            console.log();
            console.log(c.border('─'.repeat(process.stdout.columns || 80)));
            process.stdout.write(fs.readFileSync(cfgPath, "utf-8"));
            console.log();
            console.log(c.border('─'.repeat(process.stdout.columns || 80)));
            console.log(`  ${c.dim("Use /config edit to open it in your editor.")}\n`);
          }
        }
        continue;
      } else if (command === "/version") {
        console.log(`\n  ${c.bold("Ollama Code")} ${c.white("v1.0.0")}\n`);
        continue;
      } else if (command === "/update") {
        console.log(`\n  ${c.meta("⚡ Checking for updates...")}`);
        try {
          const { execFileSync } = require("child_process");
          const out = execFileSync("git", ["pull", "--ff-only"], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
          console.log(`  ${c.success(`✓ ${out.trim() || "Already up to date."}`)}\n`);
        } catch (err: any) {
          console.log(`  ${c.error(`Update failed: ${err.stderr || err.message}`)}\n`);
        }
        continue;
      } else if (command === "/cost") {
        const { usage, cost } = getUsage();
        console.log(`\n  ${c.bold("Session Usage:")}`);
        console.log(`  ${c.dim("Prompt tokens:")}     ${c.white(String(usage.promptTokens))}`);
        console.log(`  ${c.dim("Completion tokens:")} ${c.white(String(usage.completionTokens))}`);
        console.log(`  ${c.dim("Total tokens:")}      ${c.white(String(usage.totalTokens))}`);
        console.log(`  ${c.dim("Estimated cost:")}   ${c.white(formatCost(cost))}\n`);
        continue;
      } else if (command === "/login") {
        const key = parts[1];
        if (!key) {
          console.log(`\n  ${c.dim("Usage: /login <GEMINI_API_KEY>  — sets cloud credentials.")}\n`);
          continue;
        }
        const cfgPath = path.join(process.cwd(), ".ollama-code.json");
        let cfg: any = {};
        try { if (fs.existsSync(cfgPath)) cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8")); } catch { /* ignore */ }
        cfg.geminiApiKey = key;
        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf-8");
        process.env.GEMINI_API_KEY = key;
        console.log(`  ${c.success("✓ Cloud credentials set. Use /model gemini-2.5-flash to switch to cloud.")}\n`);
        continue;
      } else if (command === "/logout") {
        const cfgPath = path.join(process.cwd(), ".ollama-code.json");
        let cfg: any = {};
        try { if (fs.existsSync(cfgPath)) cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8")); } catch { /* ignore */ }
        delete cfg.geminiApiKey;
        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf-8");
        delete process.env.GEMINI_API_KEY;
        console.log(`  ${c.success("✓ Cloud credentials cleared.")}\n`);
        continue;
      } else if (command === "/statusline") {
        const { usage } = getUsage();
        const liveModel = engineerAgent.model;
        let window = 8192;
        if (liveModel instanceof OllamaLlm) window = liveModel.getContextWindow();
        const pct = window > 0 ? Math.min(100, Math.round((usage.totalTokens / window) * 100)) : 0;
        console.log(`\n  ${c.dim("Status line:")} ${c.white(displayModelName)} ${c.meta(`· ${pct}% ctx`)} ${c.dim(`· ${usage.totalTokens} tok`)} ${c.dim(`· ${isUsingOllama ? "local" : "cloud"}`)}\n`);
        continue;
      } else if (command === "/apply") {
        // Apply a patch file (git apply). Supports .patch/.diff files.
        const target = parts[1];
        if (!target) {
          console.log(`\n  ${c.dim("Usage: /apply <patch-file>  — applies a .patch/.diff file via git apply.")}\n`);
          continue;
        }
        const fullPath = path.resolve(target);
        if (!fs.existsSync(fullPath)) {
          console.log(`\n  ${c.error(`Patch file not found: ${target}`)}\n`);
          continue;
        }
        const confirmed = await confirmAction(`Apply patch ${target}?`);
        if (!confirmed) {
          console.log(`  ${c.dim("Apply cancelled.")}\n`);
          continue;
        }
        try {
          const { execFileSync } = await import("child_process");
          const out = execFileSync("git", ["apply", fullPath], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
          console.log(`  ${c.success(`✓ Applied patch ${target}.`)}${out ? " " + out.trim() : ""}\n`);
        } catch (err: any) {
          console.log(`  ${c.error(`git apply failed: ${err.stderr || err.message}`)}\n`);
        }
        continue;
      } else if (command === "/fork") {
        // Fork a new session off the current one (fresh session, same model).
        const confirmed = await confirmAction("Fork a new session from the current one?");
        if (!confirmed) {
          console.log(`  ${c.dim("Fork cancelled.")}\n`);
          continue;
        }
        session = await sessionService.createSession({ appName: runner.appName, userId: "local-user" });
        compaction.reset();
        resetUsage();
        console.log(`  ${c.success(`✓ Forked. New session: ${session.id}`)}\n`);
        continue;
      } else if (command === "/audit") {
        const entries = getAudit(parts[1] ? parseInt(parts[1], 10) : 50);
        if (entries.length === 0) {
          console.log(`\n  ${c.white("No tool calls recorded yet.")}\n`);
        } else {
          console.log(`\n  ${c.bold(`Recent Tool Calls (${entries.length}):`)}`);
          for (const e of entries) {
            const icon = e.status === "error" ? c.error("✗") : c.success("✓");
            console.log(`  ${icon} ${c.white(e.tool)} ${c.dim(`(${e.ms}ms, ${e.status})`)} ${c.dim(e.args.slice(0, 80))}`);
          }
          console.log(`\n  ${c.dim(`Full log: ${auditLogPath()}`)}\n`);
        }
        continue;
      } else if (command === "/vuln") {
        // Defensive vulnerability scan. Subcommands: static | deps | review | all.
        const sub = parts[1]?.toLowerCase() || "all";
        console.log(`\n  ${c.meta("⚡ Scanning for vulnerabilities (defensive)...")}`);
        startSpinner("Scanning...");
        try {
          let findings: any[] = [];
          if (sub === "static" || sub === "all") findings.push(...staticScan());
          if (sub === "deps" || sub === "all") findings.push(...(await dependencyScan()));
          stopSpinner();

          if (findings.length === 0) {
            console.log(`  ${c.success("✓ No vulnerabilities found by static/dependency scan.")}\n`);
            continue;
          }

          const bySeverity: Record<string, number> = {};
          for (const f of findings) bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
          console.log(`  ${c.bold(`Found ${findings.length} potential issue(s):`)}`);
          for (const [sev, n] of Object.entries(bySeverity)) {
            const icon = sev === "Critical" || sev === "High" ? c.error(sev) : c.warn(sev);
            console.log(`  ${icon}: ${n}`);
          }
          console.log();
          for (const f of findings.slice(0, 30)) {
            const sev = f.severity === "Critical" || f.severity === "High" ? c.error(f.severity) : c.warn(f.severity);
            console.log(`  ${sev} ${c.white(f.file)}:${f.line} ${c.dim(`(${f.category})`)}`);
            console.log(`    ${c.dim(f.detail)}`);
            if (f.snippet) console.log(`    ${c.dim(f.snippet.slice(0, 120))}`);
          }
          if (findings.length > 30) console.log(`  ${c.dim(`... and ${findings.length - 30} more.`)}`);

          // Optional LLM-assisted review to confirm real vs false positives.
          if (sub === "review" || sub === "all") {
            console.log(`\n  ${c.meta("⚡ Running LLM-assisted review to confirm findings...")}`);
            startSpinner("Reviewing...");
            try {
              const review = await llmReview(engineerAgent.model, findings.slice(0, 20));
              stopSpinner();
              console.log();
              process.stdout.write(review);
              console.log();
            } catch (err: any) {
              stopSpinner();
              console.log(`  ${c.dim(`(LLM review skipped: ${err.message})`)}`);
            }
          }
          console.log();
        } catch (err: any) {
          stopSpinner();
          console.log(`\n  ${c.error(`Error during vulnerability scan: ${err.message}`)}\n`);
        }
        continue;
      } else if (command === "/repro") {
        const target = parts[1];
        if (!target) {
          console.log(`\n  ${c.dim(`Usage: /repro <file>  — replays a captured request. Captures are saved to ${reproDirPath()}.`)}\n`);
          continue;
        }
        try {
          console.log(`\n  ${c.meta(`⚡ Replaying ${target}...`)}`);
          const result = await replayRepro(path.resolve(target), ollamaBaseUrl);
          console.log();
          process.stdout.write(result);
          console.log();
        } catch (err: any) {
          console.log(`\n  ${c.error(`Replay failed: ${err.message}`)}\n`);
        }
        continue;
      } else if (command === "/dream") {
        await handleAutoDream(sessionService, session.id, false);
        continue;
      } else {
        // Custom commands from config: /<name> <args> runs the configured prompt
        // template with {input} replaced by the args, via a utility agent.
        const cc = customCommands.find((c) => c.name === command.slice(1));
        if (cc) {
          const input = parts.slice(1).join(" ");
          const prompt = cc.prompt.replace(/\{input\}/g, input);
          const gitContext = await getGitContext();
          const memoryContext = getMemoryContext();
          const userPrompt = `${gitContext}${memoryContext}\n\n${prompt}`;
          console.log(`\n  ${c.meta(`⚡ Running custom command /${cc.name}...`)}`);
          startSpinner("Thinking...");
          try {
            const result = await runUtilityAgent(engineerAgent.model, "You are a helpful coding assistant. Follow the user's instruction precisely.", userPrompt, {
              tools: cc.tools ? allTools.filter((t) => cc.tools!.includes(t.name)) : allTools,
              onToken: (t) => process.stdout.write(t),
            });
            stopSpinner();
            console.log();
            if (!result.trim()) console.log(`  ${c.warn("(no output)")}`);
          } catch (err: any) {
            stopSpinner();
            console.log(`\n  ${c.error(`Error running /${cc.name}: ${err.message}`)}\n`);
          }
          continue;
        }
        console.log(`\n  ${c.error(`Unknown command: ${command}. Type /help for options.`)}\n`);
        continue;
      }
    }

    // Auto-prime the agent with Git status context on every turn
    const gitContext = await getGitContext();
    const memoryContext = getMemoryContext();

    // Inject compliance check only when user request implies a deliverable/actionable change (Ticket 3 prompt tuning feedback)
    let complianceCheck = "";
    const deliverableRegex = /\b(add|fix|create|update|implement|change|modify|delete|remove|write|setup)\b/i;
    const questionRegex = /\b(why|how|what|explain|show|status|list|read|view|find)\b|\?/i;
    if (deliverableRegex.test(userInput) && !questionRegex.test(userInput)) {
      complianceCheck = `\n\n---\nCRITICAL COMPLIANCE CHECK:\n- Did you implement every requested feature and command?`;
    }
    const fullPrompt = `${gitContext}${memoryContext}\n\nUser request: ${userInput}${complianceCheck}`;

    // Multi-file planning (plan-then-execute): before the main agent starts
    // writing code, run a lightweight planner pass that analyzes the request
    // and repo state, then inject the resulting plan into the main agent's
    // context so it executes deliberately instead of thrashing on big tasks.
    // Runs BEFORE the main LLM call, so it does not collide with the
    // OLLAMA_NUM_PARALLEL=1 constraint. Only invoked for actionable requests.
    let planBlock = "";
    if (deliverableRegex.test(userInput) && !questionRegex.test(userInput)) {
      try {
        startSpinner("Planning...");
        const plan = await generatePlan(engineerAgent.model, userInput, gitContext, memoryContext);
        stopSpinner();
        planBlock = renderPlan(plan);
        if (planBlock) {
          console.log(`  ${c.meta("📋 Plan generated — injecting into agent context")}`);
        }
      } catch (err: any) {
        stopSpinner();
        console.log(`  ${c.dim(`(planning skipped: ${err.message})`)}`);
      }
    }
    const fullPromptWithPlan = planBlock
      ? `${gitContext}${memoryContext}\n\n${planBlock}\n\nUser request: ${userInput}${complianceCheck}`
      : fullPrompt;

    // Reset token tracking for whichever OllamaLlm instance is currently live
    // (the /model command can swap engineerAgent.model to a fresh instance).
    const liveModel = engineerAgent.model;
    if (liveModel instanceof OllamaLlm) liveModel.lastResponse = null;

    printInterruptHint();
    startSpinner("Thinking...");

    // Wire an AbortController for this turn so Ctrl-C can interrupt generation
    // (Ticket 1) and ADK's native per-run LLM-call cap acts as a backstop
    // (Ticket 3, runConfig.maxLlmCalls).
    activeAbort = new AbortController();
    isGenerating = true;
    beginStream();
    let interrupted = false;
    armGenerationInterrupt(); // capture Esc / Ctrl-C mid-generation
    hooks.beforeTurn(fullPromptWithPlan, session.id, displayModelName);

    try {
      let hasOutput = false;

      for await (const event of runner.runAsync({
        userId: session.userId,
        sessionId: session.id,
        newMessage: { role: "user", parts: [{ text: fullPromptWithPlan }] },
        abortSignal: activeAbort.signal,
        runConfig: { maxLlmCalls: 60 },
      })) {
        // Ctrl-C abort: break out and return to the prompt.
        if (activeAbort.signal.aborted) { interrupted = true; break; }
        // Hard halt: if loop guard or tool cap triggered, break immediately
        if (loopGuard.halted) {
          stopSpinner();
          console.log(`\n  ${c.error('⛔ Execution halted by loop guard. The model was stuck in a rewrite loop.')}`);
          console.log(`  ${c.dim('Tip: Try breaking your prompt into smaller steps, or switch to a larger model with /model.')}\n`);
          break;
        }

        if (event.content && event.content.parts) {
          // Check for tool calls — render them inline
          const functionCalls = event.content.parts.filter((part: any) => part.functionCall);
          if (functionCalls.length > 0) {
            for (const fc of functionCalls) {
              stopSpinner();
              hooks.beforeTool(fc.functionCall!.name || "unknown", fc.functionCall!.args || {});
              printToolCall(fc.functionCall!.name || "unknown", fc.functionCall!.args || {});
              startSpinner("Thinking...");
            }
          }

          // Check for text content — render as markdown. Tokens were already
          // streamed live via onToken during generation; ADK re-emits the same
          // text as an event, so we dedup against stream.buffer to avoid
          // double-printing. For cloud mode (no onToken) the buffer is empty and
          // this renders normally.
          const text = event.content.parts
            .filter((part: any) => part.text)
            .map((part: any) => part.text)
            .join("");

          if (text) {
            if (stream.buffer && (text === stream.buffer || stream.buffer.endsWith(text) || text.endsWith(stream.buffer))) {
              // Already printed live — skip re-rendering, just clear the buffer.
              stream.buffer = "";
            } else {
              stopSpinner();
              if (!hasOutput && !stream.emittedNewline) {
                console.log(); // Breathing room before first output
              }
              hasOutput = true;
              stream.buffer = "";
              const rendered = renderMarkdown(text);
              process.stdout.write(rendered);
            }
          }
        }
      }

      stopSpinner();

      if (stream.emittedNewline) {
        process.stdout.write('\n'); // close the live-streamed line
      } else if (hasOutput) {
        process.stdout.write('\n');
      }

      // Print token usage footer
      const modelForUsage = engineerAgent.model;
      if (modelForUsage instanceof OllamaLlm && modelForUsage.lastResponse) {
        printTokenUsage(modelForUsage.lastResponse, displayModelName, modelForUsage.getContextWindow());
        recordUsage(modelForUsage.lastResponse.usage, displayModelName);
      }

      // Execute auto-commit if enabled (and not interrupted or aborted)
      if (atomicCommits && !interrupted && !loopGuard.halted) {
        await handleAutoCommit();
      }

      // Automatically consolidate project memory in MEMORY.md at the end of every turn (unless interrupted)
      if (!interrupted) {
        if (isUsingOllama) {
          // In local mode, concurrent requests block/queue in Ollama. Suggest manual consolidation instead.
          try {
            const history = await sessionService.getSession({ appName: "local-claude-ts", userId: "local-user", sessionId: session.id });
            if (history && history.events && history.events.length > 8) {
              console.log(`  ${c.dim("Tip: Your conversation history is growing. Use /dream to consolidate it into MEMORY.md.")}`);
            }
          } catch (e) {}
        } else {
          // In cloud mode, run asynchronously and silently in the background
          handleAutoDream(sessionService, session.id, true).catch(() => {});
        }
      }

      // Running-summary compaction (local mode): after the main turn finishes,
      // refresh a compact summary of the conversation. This runs SEQUENTIALLY
      // (the main LLM call is done), so it does not collide with the
      // OLLAMA_NUM_PARALLEL=1 constraint. The summary is injected into the next
      // turn's prompt via getMemoryContext(), so it survives TruncatingContextCompactor
      // dropping the raw oldest events.
      if (!interrupted && !loopGuard.halted && isUsingOllama) {
        try {
          const history = await sessionService.getSession({ appName: "local-claude-ts", userId: "local-user", sessionId: session.id });
          if (history && history.events && history.events.length > 4) {
            const historyText = history.events
              .map((event: any) => {
                const role = event.author === "user" ? "USER" : "AGENT";
                const text = stringifyContent(event) || "";
                return `${role}: ${text}`;
              })
              .join("\n\n");
            await compaction.refresh(engineerAgent.model, historyText, turnNumber);
          }
        } catch (e) {
          // Non-fatal: keep the previous summary.
        }
      }

      console.log(); // Breathing room before next prompt
      hooks.afterTurn(session.id, displayModelName);

    } catch (err: any) {
      stopSpinner();
      if (activeAbort?.signal.aborted) {
        interrupted = true;
      } else {
        console.log(`\n  ${c.error(`Error: ${err.message}`)}\n`);
      }
    } finally {
      disarmGenerationInterrupt();
      isGenerating = false;
      endStream();
      activeAbort = null;
      if (interrupted) console.log(`\n  ${c.warn('⏹ Interrupted.')}\n`);
    }
  }
}

main().catch((err) => {
  console.error(c.error(`Fatal error: ${err.message}`));
  killAllBackgroundJobs();
  closeMcpConnections().catch(() => {});
  closeLspClients();
  process.exit(1);
});
