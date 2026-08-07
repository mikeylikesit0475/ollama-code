// ─── Terminal UI ─────────────────────────────────────────────────────────────
// Color palette, spinner/streaming coordination, the readline autocomplete
// prompt, and console printers. Domain data (the slash-command list, model
// suggestions) is injected once via configurePromptSuggestions rather than
// imported directly, so this module has no dependency on cli.ts's state.

import chalk from "chalk";
import readline from "readline";

export interface SlashCommand {
  cmd: string;
  desc: string;
}

// ─── Color Palette (Claude Code Aesthetic) ───────────────────────────────────
export const c = {
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

// Simple terminal markdown renderer
export function renderMarkdown(text: string): string {
  return text
    // Bold: **text** or __text__
    .replace(/\*\*(.*?)\*\*/g, (_, m) => c.bold(m))
    .replace(/__(.*?)__/g, (_, m) => c.bold(m))
    // Inline code: `code`
    .replace(/`([^`]+)`/g, (_, m) => c.code(m))
    // Headers: # Header
    .replace(/^(#{1,3})\s+(.+)$/gm, (_, _hashes, title) => c.bold(title));
}

// ─── Prompt suggestion config (injected once by cli.ts) ─────────────────────
let promptSuggestionsConfig: {
  commands: SlashCommand[];
  getModelSuggestions: (query: string) => SlashCommand[];
} = { commands: [], getModelSuggestions: () => [] };

export function configurePromptSuggestions(config: {
  commands: SlashCommand[];
  getModelSuggestions: (query: string) => SlashCommand[];
}) {
  promptSuggestionsConfig = config;
}

// Prompt user for input, rendering real-time suggestions below the line with arrow key selection and tab autocomplete
export function promptInput(promptStr: string): Promise<string> {
  return new Promise((resolve) => {
    let lastSuggestionLinesCount = 0;
    let selectedIdx = -1;
    let currentHits: SlashCommand[] = [];
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
          currentHits = promptSuggestionsConfig.getModelSuggestions(query);
        } else {
          currentHits = promptSuggestionsConfig.commands.filter((cmdObj) => cmdObj.cmd.startsWith(trimmed));
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
        (rl as any).line = "";
        (rl as any).cursor = 0;
        clearSuggestions();
        redrawPromptLine("");
        return;
      }

      if (line.startsWith('/')) {
        // 1. Handle Enter/Return synchronously BEFORE readline processes the keystroke
        if (key && (key.name === 'return' || key.name === 'enter')) {
          if (currentHits.length > 0 && selectedIdx !== -1) {
            const selectedCmd = currentHits[selectedIdx].cmd;
            (rl as any).line = selectedCmd;
            (rl as any).cursor = selectedCmd.length;
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
            (rl as any).line = selectedCmd;
            (rl as any).cursor = selectedCmd.length;
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
              (rl as any).line = savedLine;
              (rl as any).cursor = savedLine.length;
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
      (rl as any).line = "";
      (rl as any).cursor = 0;
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
export async function confirmAction(message: string): Promise<boolean> {
  const answer = await promptInput(`  ${c.warn(message)} ${c.dim('[y/N]')} `);
  return answer.trim().toLowerCase() === 'y';
}

// Print a tool invocation line in Claude Code style
export function printToolCall(name: string, args: Record<string, any>) {
  const argStr = Object.entries(args)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? `"${v}"` : JSON.stringify(v)}`)
    .join(', ');
  console.log(`\n${c.toolBracket('⎿')} ${c.toolName(name)}${c.toolArgs(`(${argStr})`)}`);
}

// Print a tool result summary
export function printToolResult(summary: string) {
  const lines = summary.split('\n');
  for (const line of lines) {
    console.log(`  ${c.dim(line)}`);
  }
}

// Print a color-coded diff
export function printDiff(oldText: string, newText: string) {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  for (const line of oldLines) {
    console.log(`  ${c.diffDel(`- ${line}`)}`);
  }
  for (const line of newLines) {
    console.log(`  ${c.diffAdd(`+ ${line}`)}`);
  }
}

// Print token usage footer. When a context window size is provided, also
// render how full the context is (prompt tokens as a % of the window) so the
// user can see when compaction is imminent — a small local model's window
// fills fast across multi-turn sessions.
export function printTokenUsage(data: any, modelName: string, contextWindow?: number) {
  if (data?.usage) {
    const { prompt_tokens, completion_tokens, total_tokens } = data.usage;
    let ctx = "";
    if (contextWindow && contextWindow > 0) {
      const pct = Math.min(100, Math.round((prompt_tokens / contextWindow) * 100));
      const bar = ctxBar(pct);
      ctx = ` · ${bar} ${pct}%`;
    }
    console.log(`\n  ${c.meta(`─ ${total_tokens} tokens (${prompt_tokens} in, ${completion_tokens} out)${ctx} · ${modelName}`)}`);
  }
}

// Render a compact 10-cell context-fill bar, e.g. "██████░░░░".
function ctxBar(pct: number): string {
  const filled = Math.round((pct / 100) * 10);
  const color = pct >= 90 ? c.error : pct >= 70 ? c.warn : c.success;
  return color("█".repeat(filled) + "░".repeat(10 - filled));
}

// ─── Streaming output coordination ──────────────────────────────────────────
// Tokens can arrive live via the LLM adapter's onToken callback while the
// spinner is running, and ADK then re-emits the same text as a final event —
// this shared state lets the main loop dedupe that re-emission and decide
// whether to print a closing newline once generation ends.
export const stream = {
  active: false,
  emittedNewline: false,
  buffer: "",
};

export function beginStream() {
  stream.active = true;
  stream.emittedNewline = false;
  stream.buffer = "";
}

// Resets bookkeeping only — does NOT print a closing newline. Callers that
// need the closing newline check `stream.emittedNewline` themselves before
// calling this (see cli.ts's main loop), since by the time a turn ends in
// the `finally` block that decision has already been made and acted on.
export function endStream() {
  stream.active = false;
  stream.emittedNewline = false;
  stream.buffer = "";
}

export function streamToken(delta: string) {
  if (!stream.active) return;
  if (!stream.emittedNewline) {
    stopSpinner(); // clear the \r spinner line so streamed tokens don't garble it
    process.stdout.write("\n");
    stream.emittedNewline = true;
  }
  stream.buffer += delta;
  process.stdout.write(delta);
}

// ─── Spinner ─────────────────────────────────────────────────────────────────
let spinnerInterval: any = null;
let spinnerFrameIdx = 0;
const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function startSpinner(message: string) {
  stopSpinner();
  // Each spinner (re)start is a new LLM generation. Reset the streamed-newline
  // flag so the first streamed token of THIS generation stops the spinner and
  // writes on a fresh line — otherwise (after a tool call restarts the spinner)
  // tokens get blasted onto the spinning "Thinking..." line and garble it.
  stream.emittedNewline = false;
  spinnerFrameIdx = 0;
  spinnerInterval = setInterval(() => {
    const frame = spinnerFrames[spinnerFrameIdx % spinnerFrames.length];
    process.stdout.write(`\r  ${c.prompt(frame)} ${c.dim(message)}`);
    spinnerFrameIdx++;
  }, 80);
}

export function stopSpinner() {
  if (spinnerInterval) {
    clearInterval(spinnerInterval);
    spinnerInterval = null;
    process.stdout.write('\r' + ' '.repeat(60) + '\r'); // Clear the spinner line
  }
}

// ─── Static help / status / banner ──────────────────────────────────────────

export function printHelp() {
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

export function printStatus(info: { displayModelName: string; isUsingOllama: boolean; ollamaBaseUrl: string; gitSummaryLine: string }) {
  console.log();
  console.log(`  ${c.bold('System Status:')}`);
  console.log(`  ${c.bold('Model:')}   ${c.white(info.displayModelName)}`);
  if (info.isUsingOllama) {
    console.log(`  ${c.bold('Ollama:')}  ${c.white(info.ollamaBaseUrl)}`);
  }
  console.log(`  ${c.bold('Git:')}     ${c.white(info.gitSummaryLine)}`);
  console.log();
}

export function printWelcomeBanner(info: { displayModelName: string; isUsingOllama: boolean }) {
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
  console.log(`  ${c.dim(`${info.displayModelName} · ${info.isUsingOllama ? 'Ollama' : 'Gemini'}`)}`);
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
