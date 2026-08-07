import { LlmAgent, Runner, DatabaseSessionService, InMemorySessionService, setLogLevel, LogLevel, TruncatingContextCompactor, stringifyContent } from "@google/adk";
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
} from "./lib/ui.ts";
import { getGitContext, ensureGitRepository } from "./lib/workspace.ts";
import { OllamaLlm } from "./lib/ollama-llm.ts";
import { allTools, killAllBackgroundJobs } from "./lib/tools/index.ts";
import { resetLoopGuard, loopGuard } from "./lib/loop-guard.ts";

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
  { cmd: '/review', desc: 'Run adversarial code review on active diff' },
  { cmd: '/dream', desc: 'Consolidate session history into MEMORY.md' },
  { cmd: '/exit', desc: 'Exit the runtime' },
  { cmd: '/quit', desc: 'Exit the runtime' },
];

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

// Parse command line arguments for custom model flag or cloud execution mode
const startArgs = process.argv.slice(2);

if (startArgs[0] === "cloud") {
  isUsingOllama = false;
} else if (startArgs[0] === "code") {
  isUsingOllama = true;
} else {
  isUsingOllama = process.env.GEMINI_API_KEY === "ollama";
}

for (let i = 0; i < startArgs.length; i++) {
  if (startArgs[i] === "--model" && startArgs[i + 1]) {
    const val = startArgs[i + 1];
    if (val === "cloud" || val === "gemini") {
      isUsingOllama = false;
    } else {
      ollamaModelName = val;
      isUsingOllama = true;
    }
    i++;
  } else if (startArgs[i] === "--cloud" || startArgs[i] === "cloud") {
    isUsingOllama = false;
  } else if (startArgs[i] === "--code" || startArgs[i] === "code") {
    isUsingOllama = true;
  } else if (!startArgs[i].startsWith("-") && startArgs[i] !== "code" && startArgs[i] !== "cloud") {
    ollamaModelName = startArgs[i];
    isUsingOllama = true;
    const isCloudModel = startArgs[i].startsWith("gemini-") || startArgs[i].startsWith("claude-");
    if (isCloudModel) {
      isUsingOllama = false;
    }
  } else if (startArgs[i] === "--atomic-commits") {
    atomicCommits = true;
  }
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
engineerAgent.afterToolCallback = () => {
  // Restart spinner after tool completes (will be cleared when text arrives)
  startSpinner("Thinking...");
};

async function queryModelSingle(
  systemPrompt: string,
  userPrompt: string,
  onToken: (token: string) => void
): Promise<string> {
  const utilityAgent = new LlmAgent({
    name: "utility-agent",
    model: model,  // use the global model (OllamaLlm or cloud model string)
    instruction: systemPrompt,
    tools: [],
  });

  const sessionService = new InMemorySessionService();
  const utilityRunner = new Runner({
    agent: utilityAgent,
    appName: "utility-agent",
    sessionService,
  });

  const tempSessionId = `temp-session-${Math.random().toString(36).substring(2, 9)}`;
  await sessionService.createSession({
    appName: "utility-agent",
    userId: "local-user",
    sessionId: tempSessionId,
  });
  let fullText = "";

  for await (const event of utilityRunner.runAsync({
    userId: "local-user",
    sessionId: tempSessionId,
    newMessage: { role: "user", parts: [{ text: userPrompt }] }
  })) {
    if (event.content && event.content.parts) {
      const text = event.content.parts
        .filter((part: any) => part.text)
        .map((part: any) => part.text)
        .join("");
      if (text) {
        fullText += text;
        onToken(text);
      }
    }
  }
  return fullText;
}

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

    const commitMsg = (await queryModelSingle(systemPrompt, diff || "Minor updates", () => {})).trim();
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
    await queryModelSingle(systemPrompt, diff, (token) => {
      process.stdout.write(token);
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

    const historyText = history.events
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
6. This file is read back into your own context on every future turn — it is a private note to yourself, not a message to the user. Never address the user directly, ask a question, or propose next steps for them to approve (no "Shall I...", "Would you like...", or trailing questions). State facts and decisions only.`;

    const userPrompt = `Existing Memory:\n${existingMemory}\n\nRecent History:\n${historyText}`;

    const consolidatedMemory = (await queryModelSingle(systemPrompt, userPrompt, () => {})).trim();

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
  const memoryFilePath = path.resolve("MEMORY.md");
  if (fs.existsSync(memoryFilePath)) {
    try {
      const content = fs.readFileSync(memoryFilePath, "utf-8").trim();
      if (content) {
        return `\n\n---\nPROJECT MEMORY (MEMORY.md):\n${content}\n---`;
      }
    } catch (err) {
      // Ignore
    }
  }
  return "";
}

// ─── Main Loop ──────────────────────────────────────────────────────────────

async function main() {
  printWelcomeBanner({ displayModelName, isUsingOllama });
  await cacheLocalModels();


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

  // Resume the most recent session for this user if one exists; else create new.
  let session;
  try {
    const listed = await sessionService.listSessions({ appName: runner.appName, userId: "local-user" });
    const recent = listed.sessions?.[0];
    session = recent
      ? await sessionService.getSession({ appName: runner.appName, userId: "local-user", sessionId: recent.id })
      : undefined;
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

  while (true) {
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
            ollamaModelName = modelArg;
            displayModelName = modelArg;
            // Flip to cloud mode at runtime: clear the mock key so ADK uses real
            // credentials, mirroring the startup-time cloud-mode handling.
            isUsingOllama = false;
            if (process.env.GEMINI_API_KEY === "ollama") delete process.env.GEMINI_API_KEY;
            console.log(`\n  ${c.success(`✓ Switched to cloud model: ${modelArg}`)}\n`);
          } else {
            ollamaModelName = modelArg;
            displayModelName = modelArg;
            isUsingOllama = true;
            const newModel = new OllamaLlm({ model: ollamaModelName, baseUrl: ollamaBaseUrl, onToken: streamToken });
            engineerAgent.model = newModel;
            engineerAgent.instruction = systemPrompts[ollamaModelName] ?? systemPrompts["gemma4-coder-tuned:latest"]!;
            // Clear any cloud generateContentConfig so local sampling (per-model
            // params inside OllamaLlm) applies.
            engineerAgent.generateContentConfig = undefined;
            console.log(`\n  ${c.success(`✓ Switched active model to: ${ollamaModelName}`)}\n`);
          }
        }
        continue;
      } else if (command === "/status") {
        printStatus({ displayModelName, isUsingOllama, ollamaBaseUrl, gitSummaryLine: getGitContext().split('\n')[0] });
        continue;
      } else if (command === "/review" || command === "/code-review") {
        await handleAdversarialReview();
        continue;
      } else if (command === "/dream") {
        await handleAutoDream(sessionService, session.id, false);
        continue;
      } else {
        console.log(`\n  ${c.error(`Unknown command: ${command}. Type /help for options.`)}\n`);
        continue;
      }
    }

    // Auto-prime the agent with Git status context on every turn
    const gitContext = getGitContext();
    const memoryContext = getMemoryContext();

    // Inject compliance check only when user request implies a deliverable/actionable change (Ticket 3 prompt tuning feedback)
    let complianceCheck = "";
    const deliverableRegex = /\b(add|fix|create|update|implement|change|modify|delete|remove|write|setup)\b/i;
    const questionRegex = /\b(why|how|what|explain|show|status|list|read|view|find)\b|\?/i;
    if (deliverableRegex.test(userInput) && !questionRegex.test(userInput)) {
      complianceCheck = `\n\n---\nCRITICAL COMPLIANCE CHECK:\n- Did you implement every requested feature and command?`;
    }
    const fullPrompt = `${gitContext}${memoryContext}\n\nUser request: ${userInput}${complianceCheck}`;

    // Reset token tracking for whichever OllamaLlm instance is currently live
    // (the /model command can swap engineerAgent.model to a fresh instance).
    const liveModel = engineerAgent.model;
    if (liveModel instanceof OllamaLlm) liveModel.lastResponse = null;

    startSpinner("Thinking...");

    // Wire an AbortController for this turn so Ctrl-C can interrupt generation
    // (Ticket 1) and ADK's native per-run LLM-call cap acts as a backstop
    // (Ticket 3, runConfig.maxLlmCalls).
    activeAbort = new AbortController();
    isGenerating = true;
    beginStream();
    let interrupted = false;
    armGenerationInterrupt(); // capture Esc / Ctrl-C mid-generation

    try {
      let hasOutput = false;

      for await (const event of runner.runAsync({
        userId: session.userId,
        sessionId: session.id,
        newMessage: { role: "user", parts: [{ text: fullPrompt }] },
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

      console.log(); // Breathing room before next prompt

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
  process.exit(1);
});
