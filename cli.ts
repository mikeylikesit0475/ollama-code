import { FunctionTool, LlmAgent, Runner, DatabaseSessionService, BaseLlm, LlmResponse, setLogLevel, LogLevel, TruncatingContextCompactor, TokenBasedContextCompactor, LlmSummarizer, stringifyContent } from "@google/adk";
import { z } from "zod";
import chalk from "chalk";
import readline from "readline";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

// Load environment variables from .env file
dotenv.config({ path: '/Users/mikeylikesit0475/.gemini/antigravity/scratch/my-agent/.env' });

// Suppress ADK internal logging to keep the terminal output clean
setLogLevel(LogLevel.ERROR);

// ─── Color Palette (Claude Code Aesthetic) ───────────────────────────────────
const c = {
  prompt: chalk.hex('#FF9500'),       // Amber/orange prompt character
  toolName: chalk.cyan,               // Tool invocation names
  toolArgs: chalk.dim,                // Tool arguments
  toolBracket: chalk.dim.cyan,        // ⎿ bracket character
  meta: chalk.dim.gray,               // Metadata, token counts
  error: chalk.red.bold,              // Errors
  success: chalk.green,               // Success messages
  warn: chalk.yellow,                 // Warnings and confirmations
  diffAdd: chalk.green,               // Diff additions
  diffDel: chalk.red,                 // Diff deletions
  bold: chalk.bold,                   // Bold text
  code: chalk.cyan,                   // Inline code
  dim: chalk.dim,                     // Dimmed text
  white: chalk.white,                 // Standard text
  header: chalk.hex('#FF9500').bold,  // Branding header
  border: chalk.hex('#555555'),       // Visible divider lines
};

// ─── Terminal Helpers ────────────────────────────────────────────────────────

// Simple terminal markdown renderer
function renderMarkdown(text: string): string {
  return text
    // Bold: **text** or __text__
    .replace(/\*\*(.*?)\*\*/g, (_, m) => c.bold(m))
    .replace(/__(.*?)__/g, (_, m) => c.bold(m))
    // Inline code: `code`
    .replace(/`([^`]+)`/g, (_, m) => c.code(m))
    // Headers: # Header
    .replace(/^(#{1,3})\s+(.+)$/gm, (_, _hashes, title) => c.bold(title));
}

// Prompt user for input, rendering real-time suggestions below the line with arrow key selection and tab autocomplete
function promptInput(promptStr: string): Promise<string> {
  return new Promise((resolve) => {
    let lastSuggestionLinesCount = 0;
    let selectedIdx = -1;
    let currentHits: typeof commands = [];
    let savedLine = "";

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      completer: (line: string) => {
        // Return empty completions to prevent default tab completion printing
        return [[], line];
      }
    });

    const visiblePromptLen = promptStr.replace(/\u001b\[[0-9;]*m/g, '').length;
    
    const getTerminalCols = () => {
      return process.stdout.columns || 
             process.stderr.columns || 
             (process.stdin as any).columns || 
             (process.env.COLUMNS ? parseInt(process.env.COLUMNS, 10) : 0) || 
             80;
    };

    let lastPromptRows = 1;
    let lastPromptCursorRow = 0;

    const getCursorPos = (cursorIdx: number) => {
      const cols = getTerminalCols();
      const pos = visiblePromptLen + cursorIdx;
      return {
        row: Math.floor(pos / cols),
        col: pos % cols
      };
    };

    const getEndRow = (textLen: number) => {
      const cols = getTerminalCols();
      return Math.floor((visiblePromptLen + textLen) / cols);
    };

    // Helper to redraw prompt line when user autocompletes or moves cursor
    const redrawPromptLine = (text: string) => {
      const cols = getTerminalCols();
      
      // Move cursor up to the start row of the prompt
      if (lastPromptCursorRow > 0) {
        readline.moveCursor(process.stdout, 0, -lastPromptCursorRow);
      }
      
      // Clear all rows occupied by the last render of the prompt
      for (let i = 0; i < lastPromptRows; i++) {
        readline.cursorTo(process.stdout, 0);
        readline.clearLine(process.stdout, 0);
        if (i < lastPromptRows - 1) {
          readline.moveCursor(process.stdout, 0, 1);
        }
      }
      // Move cursor back up to the start row of the prompt
      if (lastPromptRows > 1) {
        readline.moveCursor(process.stdout, 0, -(lastPromptRows - 1));
      }
      
      // Print the new prompt and text
      readline.cursorTo(process.stdout, 0);
      process.stdout.write(promptStr + text);
      
      // Position the cursor at the correct position
      const cursor = getCursorPos(rl.cursor || 0);
      const endRow = getEndRow(text.length);
      if (endRow > cursor.row) {
        readline.moveCursor(process.stdout, 0, -(endRow - cursor.row));
      }
      readline.cursorTo(process.stdout, cursor.col);
      
      lastPromptRows = endRow + 1;
      lastPromptCursorRow = cursor.row;
    };

    // Helper to clear suggestions safely using relative cursor controls
    const clearSuggestions = () => {
      if (lastSuggestionLinesCount > 0) {
        const cursor = getCursorPos(rl.cursor || 0);
        const endRow = getEndRow(rl.line.length);
        const moveDown = endRow - cursor.row + 1;
        
        // Move down to suggestion lines
        readline.moveCursor(process.stdout, 0, moveDown);
        for (let i = 0; i < lastSuggestionLinesCount; i++) {
          readline.cursorTo(process.stdout, 0);
          readline.clearLine(process.stdout, 0);
          if (i < lastSuggestionLinesCount - 1) {
            readline.moveCursor(process.stdout, 0, 1);
          }
        }
        
        // Move back up to prompt line
        const moveUp = endRow + lastSuggestionLinesCount - cursor.row;
        readline.moveCursor(process.stdout, 0, -moveUp);
        readline.cursorTo(process.stdout, cursor.col);
        
        lastSuggestionLinesCount = 0;
        lastPromptCursorRow = cursor.row;
      }
    };

    // Helper to display suggestions below the prompt line
    const showSuggestions = (line: string) => {
      clearSuggestions();
      
      const trimmed = line.trim();
      const cols = getTerminalCols();
      
      const cursor = getCursorPos(rl.cursor || 0);
      const endRow = getEndRow(line.length);
      const moveDown = endRow - cursor.row + 1;
      
      // Move down to suggestion lines and write the divider
      readline.moveCursor(process.stdout, 0, moveDown);
      readline.cursorTo(process.stdout, 0);
      readline.clearLine(process.stdout, 0);
      process.stdout.write(c.border('─'.repeat(cols)));
      
      let linesCount = 1; // 1 for the horizontal divider line
      
      if (trimmed.startsWith('/')) {
        if (trimmed === '/model' || trimmed.startsWith('/model ')) {
          const query = trimmed.startsWith('/model ') ? trimmed.slice(7) : "";
          const matchingModels = downloadedModels.filter(name => name.toLowerCase().includes(query.toLowerCase()));
          if (matchingModels.length > 0) {
            currentHits = matchingModels.map(name => ({
              cmd: `/model ${name}`,
              desc: name === ollamaModelName ? 'active model' : 'local model'
            }));
          } else {
            currentHits = [];
          }
        } else {
          currentHits = commands.filter((cmdObj) => cmdObj.cmd.startsWith(trimmed));
        }

        if (currentHits.length > 0) {
          if (selectedIdx === -1) selectedIdx = 0;
          
          const maxVisible = 5;
          let startIdx = 0;
          if (selectedIdx >= startIdx + maxVisible) {
            startIdx = selectedIdx - maxVisible + 1;
          } else if (selectedIdx < startIdx) {
            startIdx = selectedIdx;
          }
          startIdx = Math.max(0, Math.min(startIdx, currentHits.length - maxVisible));
          
          const visibleHits = currentHits.slice(startIdx, startIdx + maxVisible);
          const maxCmdLen = Math.max(...visibleHits.map(h => h.cmd.length), 10);

          for (let i = 0; i < visibleHits.length; i++) {
            const actualIdx = startIdx + i;
            const hit = visibleHits[i];
            process.stdout.write('\n');
            readline.cursorTo(process.stdout, 0);
            readline.clearLine(process.stdout, 0);
            if (actualIdx === selectedIdx) {
              process.stdout.write(` ${c.prompt('❯')} ${chalk.bgHex('#FF9500').black(hit.cmd.padEnd(maxCmdLen + 2))} ${c.white(hit.desc)}`);
            } else {
              process.stdout.write(`   ${c.prompt(hit.cmd.padEnd(maxCmdLen + 2))} ${c.dim(hit.desc)}`);
            }
          }
          linesCount += visibleHits.length;
          
          const moreAbove = startIdx;
          const moreBelow = currentHits.length - (startIdx + visibleHits.length);
          if (moreAbove > 0 || moreBelow > 0) {
            process.stdout.write('\n');
            readline.cursorTo(process.stdout, 0);
            readline.clearLine(process.stdout, 0);
            const aboveStr = moreAbove > 0 ? `▲ ${moreAbove} more ` : '';
            const dividerStr = (moreAbove > 0 && moreBelow > 0) ? '· ' : '';
            const belowStr = moreBelow > 0 ? `▼ ${moreBelow} more ` : '';
            process.stdout.write(`     ${c.meta(`(${aboveStr}${dividerStr}${belowStr})`)}`);
            linesCount += 1;
          }
        } else {
          currentHits = [];
        }
      } else {
        currentHits = [];
        process.stdout.write('\n');
        readline.cursorTo(process.stdout, 0);
        readline.clearLine(process.stdout, 0);
        process.stdout.write(`  ${c.meta('? for help · /exit to quit')}`);
        linesCount += 1;
      }
      
      // Move back up to prompt line and restore cursor position
      const moveUp = endRow + linesCount - cursor.row;
      readline.moveCursor(process.stdout, 0, -moveUp);
      readline.cursorTo(process.stdout, cursor.col);
      
      lastSuggestionLinesCount = linesCount;
      lastPromptCursorRow = cursor.row;
    };



    const onKeypress = (str: string, key: any) => {
      const line = rl.line;

      // Esc: clear the current input line (don't submit, don't quit).
      if (key && key.name === 'escape') {
        savedLine = "";
        selectedIdx = -1;
        rl.line = "";
        rl.cursor = 0;
        clearSuggestions();
        redrawPromptLine("");
        return;
      }

      if (line.startsWith('/')) {
        // 1. Handle Enter/Return synchronously BEFORE readline processes the keystroke
        if (key && (key.name === 'return' || key.name === 'enter')) {
          if (currentHits.length > 0 && selectedIdx !== -1) {
            const selectedCmd = currentHits[selectedIdx].cmd;
            rl.line = selectedCmd;
            rl.cursor = selectedCmd.length;
            savedLine = selectedCmd;
            selectedIdx = -1;
            clearSuggestions();
          }
          return;
        }

        // 2. Handle Tab synchronously BEFORE readline processes the keystroke
        if (key && key.name === 'tab') {
          if (currentHits.length > 0) {
            if (selectedIdx === -1) {
              selectedIdx = 0;
            }
            const selectedCmd = currentHits[selectedIdx].cmd;
            rl.line = selectedCmd;
            rl.cursor = selectedCmd.length;
            savedLine = selectedCmd;
            selectedIdx = -1;
            redrawPromptLine(selectedCmd);
            clearSuggestions();
          }
          return;
        }

        // 3. Handle Up/Down arrow keypress selection synchronously
        if (key && (key.name === 'down' || key.name === 'up')) {
          if (currentHits.length > 0) {
            if (key.name === 'down') {
              selectedIdx = (selectedIdx + 1) % currentHits.length;
            } else {
              selectedIdx = (selectedIdx - 1 + currentHits.length) % currentHits.length;
            }
            // Defer buffer restoration to nextTick to undo readline's history-cycle
            process.nextTick(() => {
              rl.line = savedLine;
              rl.cursor = savedLine.length;
              redrawPromptLine(savedLine);
              showSuggestions(savedLine);
            });
          }
          return;
        }
      }

      // Standard character typing update (defer to let readline write it to line buffer first)
      process.nextTick(() => {
        savedLine = rl.line;
        if (!rl.line.startsWith('/')) {
          selectedIdx = -1;
        }
        showSuggestions(rl.line);
      });
    };

    // Prepend listener so we run before readline's keypress processing
    process.stdin.prependListener('keypress', onKeypress);

    // Override readline's default Ctrl-C behavior (which quits on an empty
    // line). We clear the current input instead. Registering this listener also
    // suppresses the default 'close'-on-SIGINT that would exit the process.
    rl.on('SIGINT', () => {
      savedLine = "";
      selectedIdx = -1;
      rl.line = "";
      rl.cursor = 0;
      clearSuggestions();
      redrawPromptLine("");
    });

    // Render initial status bar
    showSuggestions("");

    rl.question(promptStr, (answer) => {
      process.stdin.removeListener('keypress', onKeypress);
      clearSuggestions();
      rl.close();
      resolve(answer);
    });
  });
}


// Compact inline [y/N] confirmation
async function confirmAction(message: string): Promise<boolean> {
  const answer = await promptInput(`  ${c.warn(message)} ${c.dim('[y/N]')} `);
  return answer.trim().toLowerCase() === 'y';
}

// Print a tool invocation line in Claude Code style
function printToolCall(name: string, args: Record<string, any>) {
  const argStr = Object.entries(args)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? `"${v}"` : JSON.stringify(v)}`)
    .join(', ');
  console.log(`\n${c.toolBracket('⎿')} ${c.toolName(name)}${c.toolArgs(`(${argStr})`)}`);
}

// Print a tool result summary
function printToolResult(summary: string) {
  const lines = summary.split('\n');
  for (const line of lines) {
    console.log(`  ${c.dim(line)}`);
  }
}

// Print a color-coded diff
function printDiff(oldText: string, newText: string) {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  for (const line of oldLines) {
    console.log(`  ${c.diffDel(`- ${line}`)}`);
  }
  for (const line of newLines) {
    console.log(`  ${c.diffAdd(`+ ${line}`)}`);
  }
}

// Print token usage footer
function printTokenUsage(data: any, modelName: string) {
  if (data?.usage) {
    const { prompt_tokens, completion_tokens, total_tokens } = data.usage;
    console.log(`\n  ${c.meta(`─ ${total_tokens} tokens (${prompt_tokens} in, ${completion_tokens} out) · ${modelName}`)}`);
  }
}

// Simple animated spinner using interval
let spinnerInterval: any = null;
let spinnerFrameIdx = 0;
const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function startSpinner(message: string) {
  stopSpinner();
  // Each spinner (re)start is a new LLM generation. Reset the streamed-newline
  // flag so the first streamed token of THIS generation stops the spinner and
  // writes on a fresh line — otherwise (after a tool call restarts the spinner)
  // tokens get blasted onto the spinning "Thinking..." line and garble it.
  streamEmittedNewline = false;
  spinnerFrameIdx = 0;
  spinnerInterval = setInterval(() => {
    const frame = spinnerFrames[spinnerFrameIdx % spinnerFrames.length];
    process.stdout.write(`\r  ${c.prompt(frame)} ${c.dim(message)}`);
    spinnerFrameIdx++;
  }, 80);
}

function stopSpinner() {
  if (spinnerInterval) {
    clearInterval(spinnerInterval);
    spinnerInterval = null;
    process.stdout.write('\r' + ' '.repeat(60) + '\r'); // Clear the spinner line
  }
}

// ─── Local Slash Commands ───────────────────────────────────────────────────

const commands = [
  { cmd: '/help', desc: 'Show this help menu' },
  { cmd: '/paste', desc: 'Paste multi-line text directly from your clipboard' },
  { cmd: '/clear', desc: 'Clear the terminal screen' },
  { cmd: '/reset', desc: 'Reset conversation history (start fresh)' },
  { cmd: '/status', desc: 'Show current Git status and model status' },
  { cmd: '/review', desc: 'Run adversarial code review on active diff' },
  { cmd: '/dream', desc: 'Consolidate session history into MEMORY.md' },
  { cmd: '/exit', desc: 'Exit the runtime' },
  { cmd: '/quit', desc: 'Exit the runtime' },
  { cmd: '/code-review', desc: 'Review code changes and quality' },
  { cmd: '/add-dir', desc: 'Add directory to context' },
  { cmd: '/advisor', desc: 'Get architecture/design advice' },
  { cmd: '/agents', desc: 'Manage active subagents' },
  { cmd: '/background', desc: 'Run tasks in background' },
  { cmd: '/branch', desc: 'Create/switch Git branches' },
  { cmd: '/btw', desc: 'By the way... (add note)' },
  { cmd: '/cd', desc: 'Change working directory' },
  { cmd: '/color', desc: 'Configure terminal colors' },
  { cmd: '/compact', desc: 'Compact conversation context' },
  { cmd: '/config', desc: 'Configure agent settings' },
  { cmd: '/context', desc: 'View or modify active context' },
  { cmd: '/copy', desc: 'Copy last response or code' },
  { cmd: '/design', desc: 'Propose design system changes' },
  { cmd: '/design-login', desc: 'Review login screen design' },
  { cmd: '/diff', desc: 'Show current Git diff' },
  { cmd: '/export', desc: 'Export chat conversation' },
  { cmd: '/fast', desc: 'Toggle fast inference mode' },
  { cmd: '/feeback', desc: 'Send feedback' },
  { cmd: '/focus', desc: 'Set focus files for context' },
  { cmd: '/fork', desc: 'Fork active workspace session' },
  { cmd: '/goal', desc: 'Set primary project goal' },
  { cmd: '/hooks', desc: 'Configure pre/post execution hooks' },
  { cmd: '/ide', desc: 'Launch integrated editor' },
  { cmd: '/keybindings', desc: 'Configure keyboard shortcuts' },
  { cmd: '/login', desc: 'Authenticate services' },
  { cmd: '/mcp/', desc: 'Configure MCP server connection' },
  { cmd: '/memory', desc: 'Inspect long-term agent memory' },
  { cmd: '/mobile', desc: 'Test responsive mobile viewport' },
  { cmd: '/model', desc: 'Change active LLM model' },
  { cmd: '/permissions', desc: 'View and edit tool permissions' },
  { cmd: '/plan', desc: 'Create or view project plan' },
  { cmd: '/plugin', desc: 'Install or manage plugins' },
  { cmd: '/powerup', desc: 'Activate extra coding powerups' },
  { cmd: '/recap', desc: 'Summarize session progress' },
  { cmd: '/release-notes', desc: 'Show recent changelogs' },
  { cmd: '/reload-plugins', desc: 'Reload active MCP plugins' },
  { cmd: '/reload skills', desc: 'Reload custom agent skills' },
  { cmd: '/rename', desc: 'Rename active session or file' },
  { cmd: '/resume', desc: 'Resume previous session' },
  { cmd: '/rewind', desc: 'Undo last message/tool turn' },
  { cmd: '/scroll-speed', desc: 'Adjust output scroll speed' },
  { cmd: '/skills', desc: 'Manage active agent skills' },
  { cmd: '/tasks', desc: 'View or update tasks list' },
  { cmd: '/terminal-setup', desc: 'Configure terminal interface' },
  { cmd: '/theme', desc: 'Toggle dark/light UI theme' },
  { cmd: '/tui', desc: 'Toggle terminal UI dashboard' },
  { cmd: '/workflows', desc: 'Manage automated workflows' },
  { cmd: '/batch', desc: 'Run batch agent instructions' },
  { cmd: '/ollama-api', desc: 'Configure Ollama endpoint' },
  { cmd: '/debug', desc: 'Debug code or errors' },
  { cmd: '/deep-research', desc: 'Run deep research agent' },
  { cmd: '/design-sync', desc: 'Sync UI layout design' },
  { cmd: '/fewer-permission-prompts', desc: 'Fewer confirmation prompts' },
  { cmd: '/init', desc: 'Initialize new project configuration' },
  { cmd: '/insights', desc: 'Show code metrics/insights' },
  { cmd: '/loop', desc: 'Set up automated loops' },
  { cmd: '/review', desc: 'Review code modifications' },
  { cmd: '/run', desc: 'Run custom tool scripts' },
  { cmd: '/run-skill-generator', desc: 'Generate reusable skill script' },
  { cmd: '/security-review', desc: 'Run Snyk security review' },
  { cmd: '/simiplify', desc: 'Simplify selected code blocks' },
  { cmd: '/statusline', desc: 'Toggle status bar visibility' },
  { cmd: '/team-onboarding', desc: 'Generate onboarding guide' },
  { cmd: '/update-config', desc: 'Update settings in config' },
  { cmd: '/verify', desc: 'Run automated tests to verify changes' },
];


function printHelp() {
  console.log();
  console.log(`  ${c.bold('Available Commands:')}`);
  console.log(`  ${c.prompt('/help')}    ${c.dim('Show this help menu')}`);
  console.log(`  ${c.prompt('/paste')}   ${c.dim('Paste multi-line text directly from clipboard (avoids split prompts)')}`);
  console.log(`  ${c.prompt('/model')}   ${c.dim('Change active LLM model')}`);
  console.log(`  ${c.prompt('/clear')}   ${c.dim('Clear the terminal screen')}`);
  console.log(`  ${c.prompt('/reset')}   ${c.dim('Reset conversation history (start fresh)')}`);
  console.log(`  ${c.prompt('/status')}  ${c.dim('Show current Git status and model status')}`);
  console.log(`  ${c.prompt('/exit')}    ${c.dim('Exit the runtime')}`);
  console.log();
  console.log(`  ${c.bold('Available Tools (Model Can Invoke):')}`);
  console.log(`  ${c.meta('⎿ read_file')}      ${c.dim('Read file contents')}`);
  console.log(`  ${c.meta('⎿ write_file')}     ${c.dim('Create/overwrite a file')}`);
  console.log(`  ${c.meta('⎿ edit_file')}      ${c.dim('Search and replace text in a file')}`);
  console.log(`  ${c.meta('⎿ list_dir')}       ${c.dim('List files recursively')}`);
  console.log(`  ${c.meta('⎿ grep_search')}    ${c.dim('Search for code patterns')}`);
  console.log(`  ${c.meta('⎿ execute_bash')}   ${c.dim('Run shell commands')}`);
  console.log(`  ${c.meta('⎿ git_commit')}     ${c.dim('Commit changes to Git')}`);
  console.log();
}

function printStatus() {
  console.log();
  console.log(`  ${c.bold('System Status:')}`);
  console.log(`  ${c.bold('Model:')}   ${c.white(displayModelName)}`);
  if (isUsingOllama) {
    console.log(`  ${c.bold('Ollama:')}  ${c.white(ollamaBaseUrl)}`);
  }
  console.log(`  ${c.bold('Git:')}     ${c.white(getGitContext().split('\n')[0])}`);
  console.log();
}

function printWelcomeBanner() {
  const terminalWidth = process.stdout.columns || 
                        process.stderr.columns || 
                        (process.stdin as any).columns || 
                        (process.env.COLUMNS ? parseInt(process.env.COLUMNS, 10) : 0) || 
                        80;
  const pink = chalk.hex('#FF9595');
  const dividerWidth = Math.max(40, terminalWidth - 2);
  const divider = c.dim('─'.repeat(dividerWidth));

  console.log();
  console.log(`  ${c.bold('Ollama Code v1.0.0')}`);
  console.log(divider);
  console.log(`  ${c.bold('Welcome back!')}`);
  console.log();
  console.log(`     ${pink('▄▄▄▄▄')}`);
  console.log(`    ${pink('█ ◕ ◕ █')}`);
  console.log(`    ${pink('█▄▄▄▄▄█')}`);
  console.log();
  console.log(`  ${c.dim(`${displayModelName} · ${isUsingOllama ? 'Ollama' : 'Gemini'}`)}`);
  console.log(`  ${c.dim(process.cwd())}`);
  console.log(divider);
  console.log(`  ${chalk.yellow.bold('Tips for getting started')}`);
  console.log(`  Run ${c.prompt('/status')} to check active Git and model status`);
  console.log(`  Type ${c.prompt('/help')} to view all local slash commands`);
  console.log(`  Use ${c.prompt('/paste')} to input multi-line prompts from clipboard`);
  console.log();
  console.log(`  ${chalk.yellow.bold("What's new in v1.0.0")}`);
  console.log(`  Added real-time autocomplete suggestions on typing ${c.prompt('/')}`);
  console.log(`  Added Up/Down arrow key selection with ${c.prompt('Tab')} completion`);
  console.log(`  Added custom Ollama LLM adapter supporting local models`);
  console.log(divider);
  console.log();
}



// ─── Helpers ─────────────────────────────────────────────────────────────────

// Helper: Get Git status and diff summary to feed into the model's context window
function getGitContext(): string {
  try {
    const status = execSync("git status --porcelain", {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"]
    });
    const diff = execSync("git diff --stat", {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"]
    });
    if (!status.trim()) {
      return "Git Status: Working directory clean. No uncommitted changes.";
    }
    return `--- Current Git State ---\nModified Files:\n${status}\nDiff Summary:\n${diff}`;
  } catch (error) {
    return "Git Status: Not a git repository or git is not installed.";
  }
}

// Helper: Recursive directory listing excluding common heavy/irrelevant folders
function listDirRecursive(dir: string, baseDir = dir, depth = 0, state = { count: 0 }): string[] {
  const homeDir = process.env.HOME;
  const maxDepth = (homeDir && baseDir === homeDir) ? 1 : 5;
  if (depth > maxDepth || state.count >= 1000) {
    return [];
  }
  let results: string[] = [];
  let list: string[] = [];
  try {
    list = fs.readdirSync(dir);
  } catch (err) {
    // Gracefully skip folders we cannot read (e.g. EPERM/EACCES)
    return [];
  }

  for (const file of list) {
    if (state.count >= 1000) {
      break;
    }
    const filePath = path.join(dir, file);
    const relativePath = path.relative(baseDir, filePath);
    
    if (
      file === "node_modules" ||
      file === "bin" ||
      file === "obj" ||
      file === ".git" ||
      file === "package-lock.json" ||
      file === ".env" ||
      file === ".DS_Store" ||
      file === "Library" ||
      file === "Applications" ||
      file === "Pictures" ||
      file === "Music" ||
      file === "Movies" ||
      file === "Desktop" ||
      file === "Documents" ||
      file === "Downloads" ||
      file === "Public" ||
      file === ".Trash" ||
      file === ".npm" ||
      file === ".nvm" ||
      file === ".cache" ||
      file === ".config" ||
      file === ".vscode" ||
      file === ".ollama" ||
      file === ".ollama-code" ||
      file === ".gemini"
    ) {
      continue;
    }
    
    try {
      const stat = fs.statSync(filePath);
      if (stat && stat.isDirectory()) {
        results = results.concat(listDirRecursive(filePath, baseDir, depth + 1, state));
      } else {
        results.push(relativePath);
        state.count++;
      }
    } catch (err) {
      // Gracefully skip restricted files/folders we cannot stat
    }
  }
  return results;
}

// ─── Custom Ollama LLM Connector ────────────────────────────────────────────

interface ToolCallHistoryEntry {
  toolName: string;
  targetPath?: string;
  oldText?: string;
}
const toolCallHistory: ToolCallHistoryEntry[] = [];
let loopGuardHalted = false;
let totalToolCallsThisTurn = 0;
const MAX_TOOL_CALLS_PER_TURN = 40;

// ─── Streaming + Interrupt State (Ticket 1) ────────────────────────────────
let activeAbort: AbortController | null = null;
let isGenerating = false;
let streamingActive = false;
let streamEmittedNewline = false;
// Accumulates the text streamed live via onToken so the main loop can detect
// when ADK re-emits the same text as an event and avoid double-printing it.
let streamedTextBuffer = "";
function streamToken(delta: string) {
  if (!streamingActive) return;
  if (!streamEmittedNewline) {
    stopSpinner(); // clear the \r spinner line so streamed tokens don't garble it
    process.stdout.write("\n");
    streamEmittedNewline = true;
  }
  streamedTextBuffer += delta;
  process.stdout.write(delta);
}

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

// Stores last API response for token usage display
let lastApiResponse: any = null;

// Per-model sampling params for local Ollama models (Ticket 4).
// Replaces the old hardcoded greedy values (top_k:1, top_p:0.1) that amplified
// repetition loops in 12B models. Matches the tuned Modelfile client-side too.
const ollamaModelParams: Record<string, { temperature: number; top_k: number; top_p: number; repeat_penalty: number; repeat_last_n: number; num_predict: number; num_ctx: number }> = {
  // num_predict must be large enough for reasoning + the ENTIRE file serialized
  // as a JSON tool-call argument. The thinking model can spend ~8k tokens on
  // reasoning alone; an 8k ceiling truncated write_file mid-serialization
  // (missing the path arg), so the CLI never created the file. 16k predict +
  // 32k ctx gives reasoning + a full file room to complete.
  "gemma4-coder-tuned:latest": { temperature: 0.2, top_k: 40, top_p: 0.9, repeat_penalty: 1.15, repeat_last_n: 256, num_predict: 16384, num_ctx: 32768 },
  "gemma4:12b-mlx": { temperature: 0.3, top_k: 40, top_p: 0.9, repeat_penalty: 1.2, repeat_last_n: 512, num_predict: 16384, num_ctx: 32768 },
  "gemma4:12b": { temperature: 0.3, top_k: 40, top_p: 0.9, repeat_penalty: 1.2, repeat_last_n: 512, num_predict: 16384, num_ctx: 32768 },
};
const defaultOllamaParams = { temperature: 0.2, top_k: 40, top_p: 0.9, repeat_penalty: 1.15, repeat_last_n: 256, num_predict: 16384, num_ctx: 32768 };

class OllamaLlm extends BaseLlm {
  private readonly baseUrl: string;
  private readonly onToken?: (delta: string) => void;

  constructor({ model, baseUrl = "http://localhost:11434", onToken }: { model: string; baseUrl?: string; onToken?: (delta: string) => void }) {
    super({ model });
    this.baseUrl = baseUrl;
    this.onToken = onToken;
  }

  async *generateContentAsync(llmRequest: any, stream?: boolean, abortSignal?: AbortSignal): AsyncGenerator<LlmResponse, void> {
    const messages: any[] = [];
    const toolCallIdMap = new Map<string, string>();

    // ADK puts the agent's instruction in llmRequest.config.systemInstruction
    // (NOT in contents). Without this, the CLI's system prompt is never sent
    // to Ollama — the model only sees the Modelfile's baked-in SYSTEM. Forward
    // it as the leading system message so per-model prompts + nudges take effect.
    const si = llmRequest.config?.systemInstruction;
    if (si) {
      let siText = "";
      if (typeof si === "string") {
        siText = si;
      } else if (si.parts && Array.isArray(si.parts)) {
        siText = si.parts.map((p: any) => (typeof p.text === "string" ? p.text : "")).join("\n");
      } else {
        siText = JSON.stringify(si);
      }
      if (siText.trim()) {
        messages.push({ role: "system", content: siText });
      }
    }

    for (const content of llmRequest.contents) {
      const parts = content.parts || [];
      const isToolResponse = parts.some((p: any) => p.functionResponse);

      if (isToolResponse) {
        for (const part of parts) {
          if (part.functionResponse) {
            const name = part.functionResponse.name;
            const toolCallId = toolCallIdMap.get(name) || `call_${Math.random().toString(36).substring(2, 9)}`;
            messages.push({
              role: "tool",
              tool_call_id: toolCallId,
              name: name,
              content: JSON.stringify(part.functionResponse.response),
            });
          }
        }
      } else {
        const role = content.role === "model" ? "assistant" : content.role;
        const contentParts = parts.filter((p: any) => p.text);
        const textContent = contentParts.map((p: any) => p.text).join("\n");

        const toolCalls = parts.filter((p: any) => p.functionCall).map((p: any, index: number) => {
          const fc = p.functionCall;
          const toolCallId = `call_${fc.name}_${index}_${Math.random().toString(36).substring(2, 5)}`;
          toolCallIdMap.set(fc.name, toolCallId);
          return {
            id: toolCallId,
            type: "function",
            function: {
              name: fc.name,
              arguments: JSON.stringify(fc.args),
            }
          };
        });

        const msg: any = { role };
        msg.content = textContent || "";
        
        if (toolCalls.length > 0) {
          msg.tool_calls = toolCalls;
        }
        messages.push(msg);
      }
    }

    const tools = llmRequest.config?.tools?.map((t: any) => {
      if (t.functionDeclarations) {
        return t.functionDeclarations.map((fd: any) => ({
          type: "function",
          function: {
            name: fd.name,
            description: fd.description,
            parameters: fd.parameters,
          }
        }));
      }
      return [];
    }).flat();

    // Per-model sampling params (Ticket 4) — replaces the old hardcoded greedy
    // values (top_k:1, top_p:0.1) that amplified repetition loops in 12B models.
    const p = ollamaModelParams[this.model] ?? defaultOllamaParams;
    const temp = llmRequest.config?.temperature ?? p.temperature;

    const requestBody = {
      model: this.model,
      messages,
      tools: tools && tools.length > 0 ? tools : undefined,
      temperature: temp,
      stream: true,
      stream_options: { include_usage: true },
      options: {
        temperature: temp,
        top_k: p.top_k,
        top_p: p.top_p,
        repeat_penalty: p.repeat_penalty,
        repeat_last_n: p.repeat_last_n,
        num_predict: p.num_predict,
        num_ctx: p.num_ctx,
      }
    };

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: abortSignal,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Ollama request failed: ${errText}`);
    }

    if (!response.body) {
      throw new Error("No response body from Ollama streaming endpoint.");
    }

    // SSE parser (Ticket 1): accumulate the final assistant message while
    // streaming text deltas to the terminal via onToken. We still yield exactly
    // ONE complete LlmResponse at the end so ADK receives fully-assembled
    // functionCall parts (yielding partial tool-call fragments would break
    // tool dispatch).
    let assistantText = "";
    let reasoningText = "";
    const toolCallsAcc: any[] = [];
    let usage: any = null;
    let modelVersion: string | undefined;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const onToken = this.onToken;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nlIdx: number;
      while ((nlIdx = buffer.indexOf("\n")) >= 0) {
        const rawLine = buffer.slice(0, nlIdx).trim();
        buffer = buffer.slice(nlIdx + 1);
        if (!rawLine || !rawLine.startsWith("data:")) continue;
        const payload = rawLine.slice(5).trim();
        if (payload === "[DONE]") continue;
        let chunk: any;
        try { chunk = JSON.parse(payload); } catch { continue; }

        if (chunk.model) modelVersion = chunk.model;
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};
        // gemma4-coder is a thinking model: reasoning arrives in delta.reasoning
        // (with delta.content empty). Capture it for debugging/surfacing but do
        // NOT stream it as visible output (that's the model's private scratchpad).
        if (typeof delta.reasoning === "string" && delta.reasoning.length > 0) {
          reasoningText += delta.reasoning;
        }
        if (typeof delta.content === "string" && delta.content.length > 0) {
          assistantText += delta.content;
          if (onToken) onToken(delta.content);
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? toolCallsAcc.length;
            if (!toolCallsAcc[idx]) {
              toolCallsAcc[idx] = { id: tc.id ?? "", type: "function", function: { name: "", arguments: "" } };
            }
            if (tc.id) toolCallsAcc[idx].id = tc.id;
            if (tc.function?.name) toolCallsAcc[idx].function.name += tc.function.name;
            if (typeof tc.function?.arguments === "string") toolCallsAcc[idx].function.arguments += tc.function.arguments;
          }
        }
      }
    }

    // Assemble the final assistant message in the SAME shape the old code used,
    // so the existing responseParts -> functionCall mapping still works.
    const message: any = { role: "assistant", content: assistantText || null };
    const assembled = toolCallsAcc.filter(Boolean);
    if (assembled.length > 0) {
      message.tool_calls = assembled.map((tc: any) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.function.name, arguments: tc.function.arguments || "{}" },
      }));
    }

    const data: any = { choices: [{ message }], usage, model: modelVersion };
    lastApiResponse = data;

    // Debug dump (gated by OLLAMA_CODE_DEBUG): capture the full request ADK sent
    // (is the system prompt even there? how many tools?) and the full model
    // response (content, reasoning, tool calls) so we can diagnose why the model
    // behaves differently through the CLI vs. plain `ollama run`.
    if (process.env.OLLAMA_CODE_DEBUG) {
      try {
        const home = process.env.HOME || process.cwd();
        const logPath = path.join(home, ".ollama-code", "debug.log");
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        const sysInstrRaw = llmRequest.config?.systemInstruction;
        let sysInstrSummary = "(none in llmRequest.config.systemInstruction)";
        if (sysInstrRaw) {
          const si = typeof sysInstrRaw === "string" ? sysInstrRaw : (sysInstrRaw as any).parts?.map((p: any) => p.text || "").join("\n") || JSON.stringify(sysInstrRaw);
          sysInstrSummary = si.length > 800 ? si.slice(0, 800) + `…(+${si.length - 800} chars)` : si;
        }
        const contentsSummary = (llmRequest.contents || []).map((c: any) => ({
          role: c.role,
          parts: (c.parts || []).map((p: any) => {
            if (p.text) return { text: typeof p.text === "string" ? (p.text.length > 200 ? p.text.slice(0, 200) + `…(+${p.text.length - 200})` : p.text) : "(non-string text)" };
            if (p.functionCall) return { functionCall: p.functionCall.name, args: JSON.stringify(p.functionCall.args).slice(0, 200) };
            if (p.functionResponse) return { functionResponse: p.functionResponse.name };
            return { other: Object.keys(p)[0] || "unknown" };
          }),
        }));
        const entry = {
          time: new Date().toISOString(),
          model: this.model,
          request: {
            contents: contentsSummary,
            systemInstruction: sysInstrSummary,
            toolsCount: (llmRequest.config?.tools || []).length,
            temperature: temp,
          },
          response: {
            contentLength: (message?.content || "").length,
            contentFull: message?.content || "",
            reasoningLength: reasoningText.length,
            reasoningFull: reasoningText,
            toolCalls: (message?.tool_calls || []).map((tc: any) => ({
              name: tc.function.name,
              argsLength: tc.function.arguments.length,
              argsPreview: tc.function.arguments.slice(0, 400),
            })),
          },
        };
        fs.appendFileSync(logPath, JSON.stringify(entry, null, 2) + "\n\n----\n\n");
      } catch {
        // debug logging must never break generation
      }
    }

    const responseParts: any[] = [];
    if (message?.content) {
      responseParts.push({ text: message.content });
    }
    if (message?.tool_calls) {
      responseParts.push(...message.tool_calls.map((tc: any) => ({
        functionCall: {
          name: tc.function.name,
          args: JSON.parse(tc.function.arguments),
        }
      })));
    }

    yield {
      content: {
        role: "model",
        parts: responseParts,
      },
      modelVersion: data.model,
    };
  }

  async connect(llmRequest: any): Promise<any> {
    throw new Error("Live connection not supported for Ollama.");
  }
}

// ─── Tool Definitions ───────────────────────────────────────────────────────

const COMMON_CS_NAMESPACES: Record<string, string> = {
  "List": "using System.Collections.Generic;",
  "Dictionary": "using System.Collections.Generic;",
  "Queue": "using System.Collections.Generic;",
  "Stack": "using System.Collections.Generic;",
  "IEnumerable": "using System.Collections.Generic;",
  "IEnumerator": "using System.Collections;",
  "Task": "using System.Threading.Tasks;",
  "HttpClient": "using System.Net.Http;",
  "StringBuilder": "using System.Text;",
  "Regex": "using System.Text.RegularExpressions;",
  "JsonSerializer": "using System.Text.Json;",
  "File": "using System.IO;",
  "Directory": "using System.IO;",
  "Path": "using System.IO;",
  "Stream": "using System.IO;",
  "NavMeshAgent": "using UnityEngine.AI;",
  "NavMesh": "using UnityEngine.AI;",
  "Image": "using UnityEngine.UI;",
  "Text": "using UnityEngine.UI;",
  "Button": "using UnityEngine.UI;",
  "Slider": "using UnityEngine.UI;",
  "Toggle": "using UnityEngine.UI;",
  "TextMeshPro": "using TMPro;",
  "TMP_Text": "using TMPro;",
  "TMP_InputField": "using TMPro;",
  "Where": "using System.Linq;",
  "Select": "using System.Linq;",
  "Any": "using System.Linq;",
  "ToList": "using System.Linq;",
  "ToArray": "using System.Linq;",
  "Console": "using System;",
  "Exception": "using System;",
  "Math": "using System;",
  "Guid": "using System;"
};

function autoFixMissingNamespaces(output: string): boolean {
  const lines = output.split('\n');
  const msbuildRegex = /^(.*?)\((\d+),(\d+)\):\s*error\s+(CS0246|CS0103|CS0234):\s*(.*)$/i;
  let filesModified = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const match = msbuildRegex.exec(trimmed);
    if (!match) continue;

    const relativePath = match[1].trim();
    const fullPath = path.resolve(relativePath);
    if (!fs.existsSync(fullPath)) continue;

    const errorMsg = match[5];
    const symbolMatch = /'([^']+)'/.exec(errorMsg);
    if (!symbolMatch) continue;

    const symbol = symbolMatch[1];
    const namespaceLine = COMMON_CS_NAMESPACES[symbol];
    if (!namespaceLine) continue;

    try {
      let content = fs.readFileSync(fullPath, "utf-8");
      if (content.includes(namespaceLine)) continue;

      content = `${namespaceLine}\n${content}`;
      fs.writeFileSync(fullPath, content, "utf-8");
      console.log(chalk.green(`  ⚡ [Harness Auto-Fix]: Added "${namespaceLine}" to ${relativePath}`));
      filesModified = true;
    } catch (e: any) {
      console.log(chalk.red(`  ⚠️ [Harness Auto-Fix]: Failed to modify ${relativePath}: ${e.message}`));
    }
  }

  return filesModified;
}

function compressBuildErrors(output: string, command: string): string {
  const isBuildOrTest = /dotnet\s+(build|run|test|publish)|msbuild|csc|g\+\+|clang\+\+|make|npm\s+(run\s+)?build|tsc|pytest|npm\s+test|vitest|jest/i.test(command);
  if (!isBuildOrTest) return output;

  const lines = output.split('\n');
  const compressedLines: string[] = [];

  const msbuildRegex = /^(.*?)\((\d+),(\d+)\):\s*error\s+([A-Z0-9]+):\s*(.*)$/i;
  const gccClangRegex = /^(.*?):(\d+):(\d+):\s*error:\s*(.*)$/i;
  const tscRegex = /^(.*?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.*)$/i;
  
  const dotnetTestRegex = /Failed\s+([a-zA-Z0-9_.]+)\s*[\r\n]*\s*Error Message:\s*([\s\S]*?)(?=\s*Stack Trace:|\s*Failed\s+[a-zA-Z0-9_.]+|\r?\n\r?\n)/gi;

  if (command.includes('test')) {
    let match;
    dotnetTestRegex.lastIndex = 0;
    while ((match = dotnetTestRegex.exec(output)) !== null) {
      compressedLines.push(JSON.stringify({
        type: "TestFailure",
        test: match[1],
        message: match[2].trim().replace(/\s+/g, ' ')
      }));
    }
  }

  for (const line of lines) {
    const trimmed = line.trim();
    
    const msbuildMatch = msbuildRegex.exec(trimmed);
    if (msbuildMatch) {
      compressedLines.push(JSON.stringify({
        type: "CompilerError",
        file: path.basename(msbuildMatch[1]),
        line: parseInt(msbuildMatch[2], 10),
        column: parseInt(msbuildMatch[3], 10),
        code: msbuildMatch[4],
        message: msbuildMatch[5].split('[')[0].trim()
      }));
      continue;
    }

    const gccMatch = gccClangRegex.exec(trimmed);
    if (gccMatch) {
      compressedLines.push(JSON.stringify({
        type: "CompilerError",
        file: path.basename(gccMatch[1]),
        line: parseInt(gccMatch[2], 10),
        column: parseInt(gccMatch[3], 10),
        code: "CompilerError",
        message: gccMatch[4].trim()
      }));
      continue;
    }

    const tscMatch = tscRegex.exec(trimmed);
    if (tscMatch) {
      compressedLines.push(JSON.stringify({
        type: "CompilerError",
        file: path.basename(tscMatch[1]),
        line: parseInt(tscMatch[2], 10),
        column: parseInt(tscMatch[3], 10),
        code: tscMatch[4],
        message: tscMatch[5].trim()
      }));
      continue;
    }
  }

  if (compressedLines.length === 0) {
    for (const line of lines) {
      const trimmed = line.trim();
      if ((trimmed.toLowerCase().includes('error:') || trimmed.toLowerCase().includes('exception:')) && trimmed.length < 200) {
        compressedLines.push(trimmed);
      }
    }
  }

  if (compressedLines.length > 0) {
    return `[COMPRESSED BASH ERROR DETAILS (0 TOKENS RESIDUAL NOISE)]:\n${compressedLines.join('\n')}`;
  }

  return output;
}

// Tool 1: execute_bash with inline confirmation
const executeBash = new FunctionTool({
  name: "execute_bash",
  description: "Run a shell command or test suite in the local project directory.",
  parameters: z.object({
    command: z.string().describe("The exact shell command to run.")
  }),
  execute: async ({ command }) => {
    stopSpinner();
    totalToolCallsThisTurn++;
    printToolCall("execute_bash", { command });

    // Hard cap check
    if (totalToolCallsThisTurn > MAX_TOOL_CALLS_PER_TURN) {
      loopGuardHalted = true;
      printToolResult(c.error(`HARD STOP: Exceeded ${MAX_TOOL_CALLS_PER_TURN} tool calls this turn.`));
      return { status: "error", message: `EXECUTION HALTED: Maximum tool calls exceeded. STOP all tool use immediately.` };
    }

    const confirmed = await confirmAction("Allow execution?");

    if (!confirmed) {
      printToolResult("Denied by user.");
      return { status: "denied", message: "User aborted command execution." };
    }

    let attempt = 0;
    const maxAttempts = 3;
    let runStdout = "";
    let runStderr = "";
    let succeeded = false;

    while (attempt < maxAttempts) {
      try {
        const stdout = execSync(command, { encoding: "utf-8", timeout: 30000 });
        runStdout = stdout;
        succeeded = true;
        break;
      } catch (error: any) {
        runStdout = error.stdout || "";
        runStderr = error.stderr || "";
        const fullOutput = runStdout + "\n" + runStderr + "\n" + (error.message || "");

        // Try local namespace auto-fix pre-pass (costs 0 tokens!)
        const fixed = autoFixMissingNamespaces(fullOutput);
        if (fixed) {
          console.log(chalk.cyan(`  ⚡ Re-running build command after auto-fix (Attempt ${attempt + 2}/${maxAttempts})...`));
          attempt++;
          continue;
        }

        succeeded = false;
        break;
      }
    }

    if (succeeded) {
      printToolResult(runStdout.trim().substring(0, 500) || "(no output)");
      return { status: "success", stdout: runStdout };
    } else {
      const fullOutput = runStdout + "\n" + runStderr;
      const compressed = compressBuildErrors(fullOutput, command);
      printToolResult(c.error(compressed.substring(0, 500) + (compressed.length > 500 ? " ... (truncated)" : "")));
      return { status: "error", stderr: compressed };
    }
  }
});

// Tool 2: read_file (non-interactive)
const readFile = new FunctionTool({
  name: "read_file",
  description: "Safely read the text content of a local project file.",
  parameters: z.object({
    path: z.string().describe("Relative path to the target file.")
  }),
  execute: async ({ path: filePath }) => {
    try {
      const fullPath = path.resolve(filePath);
      const content = fs.readFileSync(fullPath, "utf-8");
      return { status: "success", content };
    } catch (error: any) {
      stopSpinner();
      printToolResult(c.error(`Error reading ${filePath}: ${error.message}`));
      return { status: "error", message: error.message };
    }
  }
});

// Tool 3: write_file with inline confirmation and loop guard
const writeFile = new FunctionTool({
  name: "write_file",
  description: "Create a new file or completely overwrite an existing file at a specified path. WARNING: Avoid using write_file to edit existing files or correct syntax errors as it often introduces new typos; instead, use edit_file to make targeted edits.",
  parameters: z.object({
    path: z.string().describe("Relative path to the target file."),
    content: z.string().describe("The exact text content to write to the file.")
  }),
  execute: async ({ path: filePath, content }) => {
    stopSpinner();
    totalToolCallsThisTurn++;
    printToolCall("write_file", { path: filePath });

    // Hard cap: if total tool calls exceeded, halt immediately
    if (totalToolCallsThisTurn > MAX_TOOL_CALLS_PER_TURN) {
      loopGuardHalted = true;
      printToolResult(c.error(`HARD STOP: Exceeded ${MAX_TOOL_CALLS_PER_TURN} tool calls this turn. Halting execution.`));
      return {
        status: "error",
        message: `EXECUTION HALTED: You have exceeded the maximum of ${MAX_TOOL_CALLS_PER_TURN} tool calls per user turn. STOP all tool use immediately. Summarize what you have accomplished so far and wait for the user's next instruction.`
      };
    }

    const fullPath = path.resolve(filePath);

    // Hard repeat-write guard (Ticket 3): a path may be fully written at most
    // ONCE per turn. A second write_file to the same path is rejected and the
    // model is told to use edit_file. (Does NOT set loopGuardHalted — let the
    // turn continue so the model can switch to edit_file.)
    const duplicateWrites = toolCallHistory.filter(
      entry => entry.toolName === "write_file" && entry.targetPath === fullPath
    );

    if (duplicateWrites.length >= 1) {
      printToolResult(c.error(`BLOCKED: "${filePath}" was already written this turn. Use edit_file for further changes.`));
      return {
        status: "error",
        message: `BLOCKED: write_file to "${filePath}" is not allowed — this file was already created/overwritten this turn. To change an existing file you MUST use edit_file (oldText -> newText). Do not call write_file on this path again.`
      };
    }

    // Record this write attempt NOW (before confirmation) so denials/retries
    // also count toward the repeat guard. Prevents "retry until user says yes."
    toolCallHistory.push({ toolName: "write_file", targetPath: fullPath });

    const preview = content.substring(0, 500);
    printToolResult(preview + (content.length > 500 ? "\n  ... (truncated)" : ""));

    const relativeDisplayPath = path.relative(process.cwd(), fullPath) || filePath;
    const confirmed = await confirmAction(`Write to ${relativeDisplayPath}?`);

    if (!confirmed) {
      printToolResult("Denied by user.");
      return { status: "denied", message: "User aborted file write operation." };
    }

    try {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, "utf-8");
      printToolResult(c.success(`✓ Wrote ${relativeDisplayPath}`));
      return { status: "success", message: `Successfully wrote file to ${filePath}` };
    } catch (error: any) {
      printToolResult(c.error(`Error writing ${relativeDisplayPath}: ${error.message}`));
      return { status: "error", message: error.message };
    }
  }
});

// Tool 4: edit_file with color-coded diff and inline confirmation
const editFile = new FunctionTool({
  name: "edit_file",
  description: "Make a precise modification to an existing file by replacing a unique block of text (oldText) with a new block of text (newText). Prefer this tool over write_file when modifying existing files or fixing syntax errors.",
  parameters: z.object({
    path: z.string().describe("Relative path to the file to modify."),
    oldText: z.string().describe("The exact, unique block of text to be replaced."),
    newText: z.string().describe("The new block of text to replace it with.")
  }),
  execute: async ({ path: filePath, oldText, newText }) => {
    stopSpinner();
    totalToolCallsThisTurn++;
    printToolCall("edit_file", { path: filePath });

    // Hard cap check
    if (totalToolCallsThisTurn > MAX_TOOL_CALLS_PER_TURN) {
      loopGuardHalted = true;
      printToolResult(c.error(`HARD STOP: Exceeded ${MAX_TOOL_CALLS_PER_TURN} tool calls this turn.`));
      return { status: "error", message: `EXECUTION HALTED: Maximum tool calls exceeded. STOP all tool use immediately.` };
    }

    const fullPath = path.resolve(filePath);

    // Repeat-edit guard (Ticket 3): the exact same edit (same path + same
    // oldText) attempted twice in a row means the model is stuck on a
    // whitespace mismatch. Block it and tell it to re-read the file first.
    const recent = toolCallHistory[toolCallHistory.length - 1];
    if (recent && recent.toolName === "edit_file" && recent.targetPath === fullPath && recent.oldText === oldText) {
      printToolResult(c.error("BLOCKED: identical edit repeated. The oldText did not match — re-read the file first."));
      return {
        status: "error",
        message: `BLOCKED: you just attempted the exact same edit to "${filePath}" and it failed (oldText not found). Do not repeat it. Call read_file on "${filePath}" first to see the current exact contents, then call edit_file with a corrected oldText that matches exactly (mind whitespace and indentation).`
      };
    }
    toolCallHistory.push({ toolName: "edit_file", targetPath: fullPath, oldText });

    printDiff(oldText, newText);

    const relativeDisplayPath = path.relative(process.cwd(), fullPath) || filePath;
    const confirmed = await confirmAction(`Apply changes to ${relativeDisplayPath}?`);

    if (!confirmed) {
      printToolResult("Denied by user.");
      return { status: "denied", message: "User aborted file edit operation." };
    }

    try {
      if (!fs.existsSync(fullPath)) {
        printToolResult(c.error(`Error: File does not exist: ${relativeDisplayPath}`));
        return { status: "error", message: `File does not exist: ${filePath}` };
      }

      const fileContent = fs.readFileSync(fullPath, "utf-8");
      let occurrences = fileContent.split(oldText).length - 1;
      let startIdx = -1;
      let endIdx = -1;
      let isFuzzy = false;

      if (occurrences === 0) {
        const fuzzy = findFuzzyMatch(fileContent, oldText);
        if (fuzzy) {
          occurrences = 1;
          startIdx = fuzzy.start;
          endIdx = fuzzy.end;
          isFuzzy = true;
        }
      } else {
        startIdx = fileContent.indexOf(oldText);
        endIdx = startIdx + oldText.length;
      }
      
      if (occurrences === 0) {
        printToolResult(c.error("oldText not found in file."));
        return { 
          status: "error", 
          message: "Could not find 'oldText' in the target file. Make sure spelling, whitespace, and formatting match exactly." 
        };
      }
      if (occurrences > 1) {
        printToolResult(c.error("Multiple matches — provide more context."));
        return { 
          status: "error", 
          message: "Found multiple occurrences of 'oldText' in the target file. Please include more surrounding context lines in 'oldText' to make it unique." 
        };
      }

      if (isFuzzy) {
        console.log(`  ${c.warn("⚡ Warning: Matched oldText with fuzzy whitespace normalization.")}`);
      }

      const updatedContent = fileContent.substring(0, startIdx) + newText + fileContent.substring(endIdx);
      fs.writeFileSync(fullPath, updatedContent, "utf-8");
      printToolResult(c.success(`✓ Modified ${relativeDisplayPath}`));
      return { status: "success", message: `Successfully modified ${filePath}. Diff:\n- ${oldText.trim().replace(/\n/g, '\n- ')}\n+ ${newText.trim().replace(/\n/g, '\n+ ')}` };
    } catch (error: any) {
      printToolResult(c.error(`Error editing ${relativeDisplayPath}: ${error.message}`));
      return { status: "error", message: error.message };
    }
  }
});

// Tool 5: list_dir (non-interactive)
const listDir = new FunctionTool({
  name: "list_dir",
  description: "Recursively list files in the current workspace, ignoring node_modules and version control directories.",
  parameters: z.object({
    path: z.string().optional().describe("Relative path to listing start. Defaults to the root directory.")
  }),
  execute: async ({ path: startPath = "." }) => {
    try {
      const resolvedStart = path.resolve(startPath);
      if (!fs.existsSync(resolvedStart)) {
        return { status: "error", message: `Directory does not exist: ${startPath}` };
      }
      const files = listDirRecursive(resolvedStart);
      return { status: "success", files };
    } catch (error: any) {
      return { status: "error", message: error.message };
    }
  }
});

// Tool 6: grep_search (non-interactive)
const grepSearch = new FunctionTool({
  name: "grep_search",
  description: "Search for occurrences of a text pattern across the codebase.",
  parameters: z.object({
    query: z.string().describe("The search term or pattern to look for.")
  }),
  execute: async ({ query }) => {
    try {
      let stdout = "";
      let isGit = false;
      try {
        execSync("git rev-parse --is-inside-work-tree", { stdio: "ignore" });
        isGit = true;
      } catch (e) {}

      if (isGit) {
        stdout = execSync(`git grep -n -F "${query}"`, { encoding: "utf-8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] });
      } else {
        const files = listDirRecursive(".");
        const matches: string[] = [];
        for (const file of files) {
          const content = fs.readFileSync(file, "utf-8");
          const lines = content.split("\n");
          lines.forEach((line, index) => {
            if (line.includes(query)) {
              matches.push(`${file}:${index + 1}:${line}`);
            }
          });
        }
        stdout = matches.join("\n");
      }
      return { status: "success", results: stdout || "No matches found." };
    } catch (error: any) {
      return { status: "success", results: "No matches found." };
    }
  }
});

function isPathInWorkspace(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  const workspaceRoot = path.resolve(process.cwd());
  return resolved.startsWith(workspaceRoot);
}

// Tool 7: git_commit with inline confirmation
const gitCommit = new FunctionTool({
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

    const confirmed = await confirmAction("Commit changes?");

    if (!confirmed) {
      printToolResult("Denied by user.");
      return { status: "denied", message: "User aborted Git commit." };
    }

    try {
      // Stage only tracked files (prevents untracked binaries from being staged)
      execSync("git add -u", { stdio: "ignore" });
      const stdout = execSync(`git commit -m "${message}"`, { encoding: "utf-8" });
      printToolResult(c.success(stdout.trim()));
      return { status: "success", message: stdout };
    } catch (error: any) {
      return { status: "error", message: error.message };
    }
  }
});

// Tool 8: git_status (non-interactive)
const gitStatus = new FunctionTool({
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
const gitAdd = new FunctionTool({
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
    const confirmed = await confirmAction(`Stage ${relativeDisplayPath}?`);
    if (!confirmed) {
      printToolResult("Denied by user.");
      return { status: "denied", message: "User aborted Git add." };
    }

    try {
      execSync(`git add "${filePath}"`);
      printToolResult(c.success(`✓ Staged ${relativeDisplayPath}`));
      return { status: "success", message: `Successfully staged ${filePath}` };
    } catch (error: any) {
      printToolResult(c.error(`Error staging ${relativeDisplayPath}: ${error.message}`));
      return { status: "error", message: error.message };
    }
  }
});

// Tool 10: git_diff (non-interactive)
const gitDiff = new FunctionTool({
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
const gitLog = new FunctionTool({
  name: "git_log",
  description: "View the recent commit log history.",
  parameters: z.object({
    count: z.number().optional().default(5).describe("Number of recent commits to list.")
  }),
  execute: async ({ count = 5 }) => {
    try {
      const isGit = await ensureGitRepository();
      if (!isGit) return { status: "error", message: "Git is not initialized in this directory." };
      const stdout = execSync(`git log -n ${count} --oneline`, { encoding: "utf-8" });
      return { status: "success", message: stdout || "No commit history found" };
    } catch (error: any) {
      return { status: "error", message: error.message };
    }
  }
});

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
  "gemma4-coder-tuned:latest": `You are an autonomous coding agent (like Claude Code) with tools: execute_bash, read_file, write_file, edit_file, list_dir, grep_search, git_commit, git_status, git_add, git_diff, git_log.
Custom tools are available for Git reads (status, diff, log) and do not require manual user confirmation. Always inspect your changes with git_status or git_diff before committing.

Workflow:
1. PLAN: Before writing code, think BRIEFLY (a few sentences) about the approach. Do not over-deliberate.
2. WRITE ONCE: Produce the COMPLETE, finished file in a SINGLE write_file call. Never write partial code, stubs, or placeholders. Always include BOTH arguments: path and the full content. Do not emit code as a markdown code block — emit it via the write_file tool call.
3. NO REWRITES: If a file already exists, never use write_file to recreate it. Use edit_file (oldText -> newText, match whitespace exactly) to change only the lines that need fixing.
4. VERIFY: After writing, run the code with execute_bash. If it errors, read the error and use edit_file to fix the broken lines.
5. NO SELF-TALK IN CODE: Never put apologies, hesitation, or running commentary inside code. Comments must be useful documentation only.
6. FINISH: When the task is complete, stop calling tools and summarize what you did in plain text.

IMPORTANT: Keep your reasoning short. When you call write_file, always include the 'path' argument and the complete file in 'content'.`,
  "gemma4:12b-mlx": `You are a coding agent with tools: execute_bash, read_file, write_file, edit_file, list_dir, grep_search, git_commit, git_status, git_add, git_diff, git_log. Use tools, not narration. Write a file ONCE with write_file; edit existing files only with edit_file (oldText->newText, match whitespace exactly). Never rewrite a file you already wrote. If an edit fails, read_file again before retrying. Stop and summarize in plain text when done.`,
  "gemma4:12b": `You are a coding agent with tools: execute_bash, read_file, write_file, edit_file, list_dir, grep_search, git_commit, git_status, git_add, git_diff, git_log. Use tools, not narration. Write a file ONCE with write_file; edit existing files only with edit_file (oldText->newText, match whitespace exactly). Never rewrite a file you already wrote. If an edit fails, read_file again before retrying. Stop and summarize in plain text when done.`,
};

const cloudModelName = "gemini-2.5-flash";
const cloudPrompts: Record<string, string> = {
  "gemini-2.5-flash": `You are a senior coding agent with tools: execute_bash, read_file, write_file, edit_file, list_dir, grep_search, git_commit. Use tools to plan, write, edit, and verify code. Prefer edit_file over write_file for existing files. Be concise. Summarize in plain text when done.`,
};
const cloudParams: Record<string, { temperature: number; topP: number; topK: number; maxOutputTokens: number }> = {
  "gemini-2.5-flash": { temperature: 0.2, topP: 0.95, topK: 40, maxOutputTokens: 8192 },
};

const activeModelName = isUsingOllama ? ollamaModelName : cloudModelName;
const instruction = isUsingOllama
  ? (systemPrompts[activeModelName] ?? systemPrompts["gemma4-coder-tuned:latest"]!)
  : (cloudPrompts[activeModelName] ?? cloudPrompts[cloudModelName]!);

// A separate OllamaLlm for context summarization (no onToken — summary text
// must NOT stream to the console). Only available in Ollama mode.
const summarizerLlm = isUsingOllama ? new OllamaLlm({ model: ollamaModelName, baseUrl: ollamaBaseUrl }) : undefined;

const model = isUsingOllama
  ? new OllamaLlm({ model: ollamaModelName, baseUrl: ollamaBaseUrl, onToken: streamToken })
  : cloudModelName; // ADK's default Gemini connector handles a bare string model.

let displayModelName = isUsingOllama ? ollamaModelName : cloudModelName;

// Context compactors (Ticket 2). In Ollama mode, summarize oldest events into
// one CompactedEvent before the 16k context window fills (real summarization via
// the local model), with a hard truncation backstop. In cloud mode, Gemini's
// context window is huge — a simple truncation backstop is enough.
const contextCompactors = isUsingOllama && summarizerLlm
  ? [
      new TokenBasedContextCompactor({
        tokenThreshold: 12000,
        eventRetentionSize: 6,
        summarizer: new LlmSummarizer({ llm: summarizerLlm }),
      }),
      new TruncatingContextCompactor({ threshold: 60, preserveLeadingEvents: 4 }),
    ]
  : [
      new TruncatingContextCompactor({ threshold: 40, preserveLeadingEvents: 4 }),
    ];

const agentConfig: any = {
  name: "local-claude-ts",
  model: model,
  instruction,
  tools: [executeBash, readFile, writeFile, editFile, listDir, grepSearch, gitCommit, gitStatus, gitAdd, gitDiff, gitLog],
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

function findFuzzyMatch(content: string, target: string): { start: number; end: number } | null {
  const escaped = target.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  const normalizedPattern = escaped
    .replace(/\s+/g, '\\s+')
    .replace(/(?:\\s\+)+/g, '\\s+');
  
  try {
    const regex = new RegExp(normalizedPattern, 'g');
    const matches = [...content.matchAll(regex)];
    if (matches.length === 1) {
      const m = matches[0];
      return { start: m.index!, end: m.index! + m[0].length };
    }
  } catch (e) {
    // regex compile error
  }
  return null;
}

async function ensureGitRepository(): Promise<boolean> {
  try {
    execSync("git rev-parse --is-inside-work-tree", { stdio: "ignore" });
    return true;
  } catch {
    stopSpinner();
    const initialize = await confirmAction("Git is not initialized in this directory. Run 'git init' now?");
    if (initialize) {
      try {
        execSync("git init", { stdio: "inherit" });
        console.log(`  ${c.success("✓ Initialized empty Git repository.")}`);
        return true;
      } catch (err: any) {
        console.log(`  ${c.error(`Failed to initialize git: ${err.message}`)}`);
      }
    }
    return false;
  }
}

async function queryModelSingle(
  systemPrompt: string,
  userPrompt: string,
  onToken: (token: string) => void
): Promise<string> {
  const utilityAgent = new LlmAgent({
    name: "utility-agent",
    model: engineerAgent.model,
    instruction: systemPrompt,
    tools: [],
  });

  const utilityRunner = new Runner({
    agent: utilityAgent,
    appName: "utility-agent",
  });

  const tempSessionId = `temp-session-${Math.random().toString(36).substring(2, 9)}`;
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
    execSync(`git commit -m "${commitMsg}"`, { stdio: "ignore" });
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

async function handleAutoDream(sessionService: any, sessionId: string) {
  try {
    const history = await sessionService.getSession({ appName: "local-claude-ts", userId: "local-user", sessionId });
    if (!history || !history.events || history.events.length <= 1) {
      console.log(`\n  ${c.white("No conversation history available to consolidate.")}\n`);
      return;
    }

    console.log(`\n  ${c.meta("⚡ Auto-Dream: Consolidating memory into MEMORY.md...")}`);
    startSpinner("Thinking...");

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
5. Return ONLY the complete, raw markdown content for the MEMORY.md file. No markdown code blocks surrounding the output, no talking.`;

    const userPrompt = `Existing Memory:\n${existingMemory}\n\nRecent History:\n${historyText}`;

    const consolidatedMemory = (await queryModelSingle(systemPrompt, userPrompt, () => {})).trim();

    fs.writeFileSync(memoryFilePath, consolidatedMemory, "utf-8");
    stopSpinner();
    console.log(`  ${c.success("✓ Successfully consolidated memory into MEMORY.md!")}\n`);
  } catch (err: any) {
    stopSpinner();
    console.log(`\n  ${c.error(`Error during memory consolidation: ${err.message}`)}\n`);
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
  printWelcomeBanner();
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
    toolCallHistory.length = 0;
    loopGuardHalted = false;
    totalToolCallsThisTurn = 0;

    // Local Slash Commands Handler
    if (userInput.trim().startsWith("/")) {
      const parts = userInput.trim().split(/\s+/);
      const command = parts[0].toLowerCase();

      if (command === "/exit" || command === "/quit") {
        console.log(`\n  ${c.dim('Goodbye.')}\n`);
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
        try {
          let clipboardText = "";
          if (process.platform === "darwin") {
            clipboardText = execSync("pbpaste", { encoding: "utf-8" });
          } else if (process.platform === "win32") {
            clipboardText = execSync("powershell -Command Get-Clipboard", { encoding: "utf-8" });
          } else {
            clipboardText = execSync("xclip -selection clipboard -o || xsel -b -o", { encoding: "utf-8" });
          }
          
          if (!clipboardText.trim()) {
            console.log(`\n  ${c.error("Clipboard is empty.")}\n`);
            continue;
          }
          
          console.log(`\n  ${c.success(`✓ Pasted ${clipboardText.split('\n').length} lines from clipboard:`)}`);
          console.log(c.dim(clipboardText.trim()));
          console.log();
          
          userInput = clipboardText;
        } catch (err: any) {
          console.log(`\n  ${c.error(`Failed to read clipboard: ${err.message}`)}\n`);
          continue;
        }
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
        printStatus();
        continue;
      } else if (command === "/review" || command === "/code-review") {
        await handleAdversarialReview();
        continue;
      } else if (command === "/dream") {
        await handleAutoDream(sessionService, session.id);
        continue;
      } else {
        const isKnown = commands.some(cmdObj => {
          const cleanCmd = cmdObj.cmd.toLowerCase();
          return command.startsWith(cleanCmd) || cleanCmd.startsWith(command);
        });
        if (isKnown) {
          console.log(`\n  ${c.meta(`⚡ Forwarding command to agent: ${userInput}`)}\n`);
        } else {
          console.log(`\n  ${c.error(`Unknown command: ${command}. Type /help for options.`)}\n`);
          continue;
        }
      }
    }

    // Auto-prime the agent with Git status context on every turn
    const gitContext = getGitContext();
    const memoryContext = getMemoryContext();
    const complianceCheck = `
---
CRITICAL COMPLIANCE CHECK:
- Did you implement every requested feature and command?
- Did you verify all variable names are lowercase?`;
    const fullPrompt = `${gitContext}${memoryContext}\n\nUser request: ${userInput}${complianceCheck}`;

    // Reset token tracking
    lastApiResponse = null;

    startSpinner("Thinking...");

    // Wire an AbortController for this turn so Ctrl-C can interrupt generation
    // (Ticket 1) and ADK's native per-run LLM-call cap acts as a backstop
    // (Ticket 3, runConfig.maxLlmCalls).
    activeAbort = new AbortController();
    isGenerating = true;
    streamingActive = true;
    streamEmittedNewline = false;
    streamedTextBuffer = "";
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
        if (loopGuardHalted) {
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
              printToolCall(fc.functionCall.name, fc.functionCall.args);
              startSpinner("Thinking...");
            }
          }

          // Check for text content — render as markdown. Tokens were already
          // streamed live via onToken during generation; ADK re-emits the same
          // text as an event, so we dedup against streamedTextBuffer to avoid
          // double-printing. For cloud mode (no onToken) the buffer is empty and
          // this renders normally.
          const text = event.content.parts
            .filter((part: any) => part.text)
            .map((part: any) => part.text)
            .join("");

          if (text) {
            if (streamedTextBuffer && (text === streamedTextBuffer || streamedTextBuffer.endsWith(text) || text.endsWith(streamedTextBuffer))) {
              // Already printed live — skip re-rendering, just clear the buffer.
              streamedTextBuffer = "";
            } else {
              stopSpinner();
              if (!hasOutput && !streamEmittedNewline) {
                console.log(); // Breathing room before first output
              }
              hasOutput = true;
              streamedTextBuffer = "";
              const rendered = renderMarkdown(text);
              process.stdout.write(rendered);
            }
          }
        }
      }

      stopSpinner();

      if (streamEmittedNewline) {
        process.stdout.write('\n'); // close the live-streamed line
      } else if (hasOutput) {
        process.stdout.write('\n');
      }

      // Print token usage footer
      if (lastApiResponse) {
        printTokenUsage(lastApiResponse, displayModelName);
      }

      // Execute auto-commit if enabled (and not interrupted or aborted)
      if (atomicCommits && !interrupted && !loopGuardHalted) {
        await handleAutoCommit();
      }

      // Automatically consolidate project memory in MEMORY.md at the end of every turn (unless interrupted)
      if (!interrupted) {
        await handleAutoDream(sessionService, session.id);
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
      streamingActive = false;
      activeAbort = null;
      streamedTextBuffer = "";
      if (streamEmittedNewline) streamEmittedNewline = false;
      if (interrupted) console.log(`\n  ${c.warn('⏹ Interrupted.')}\n`);
    }
  }
}

main().catch((err) => {
  console.error(c.error(`Fatal error: ${err.message}`));
  process.exit(1);
});
