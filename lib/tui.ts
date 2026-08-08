// ─── Lightweight TUI (session browser) ───────────────────────────────────────
// A minimal full-screen session browser built on raw ANSI escape codes (no
// external deps). Lists past sessions, lets the user arrow-key to select one,
// and returns the chosen session id (or null to cancel). Used by --tui mode.
//
// This is intentionally small: it renders a list, handles up/down/enter/esc,
// and restores the terminal on exit. It is not a full panel-based TUI, but it
// gives the "session list" ergonomics opencode has.

import readline from "readline";

interface TuiSession {
  id: string;
  title: string;
}

const ESC = "\x1b";
const CSI = "\x1b[";

function hideCursor() { process.stdout.write(CSI + "?25l"); }
function showCursor() { process.stdout.write(CSI + "?25h"); }
function clearScreen() { process.stdout.write(CSI + "2J" + CSI + "H"); }
function moveTo(row: number, col: number) { process.stdout.write(CSI + row + ";" + col + "H"); }
function setBg(color: string) { process.stdout.write(CSI + color + "m"); }
function resetStyle() { process.stdout.write(CSI + "0m"); }

// Render the session list and return the selected session id (or null).
export async function sessionBrowser(sessions: TuiSession[]): Promise<string | null> {
  if (sessions.length === 0) {
    console.log("No past sessions found.");
    return null;
  }

  const rows = process.stdout.rows || 24;
  const cols = process.stdout.columns || 80;
  const listHeight = Math.min(sessions.length, rows - 4);
  let selected = 0;
  let scroll = 0;

  const render = () => {
    clearScreen();
    moveTo(1, 1);
    setBg("44"); // blue bar
    process.stdout.write("  Ollama Code — Session Browser  (↑/↓ select, Enter open, Esc cancel)");
    resetStyle();
    for (let i = 0; i < listHeight; i++) {
      const idx = scroll + i;
      if (idx >= sessions.length) break;
      const s = sessions[idx];
      const title = s.title.length > cols - 6 ? s.title.slice(0, cols - 9) + "..." : s.title;
      moveTo(i + 2, 1);
      if (idx === selected) {
        setBg("7"); // reverse video
        process.stdout.write("  > " + title.padEnd(cols - 4));
        resetStyle();
      } else {
        process.stdout.write("    " + title.padEnd(cols - 4));
      }
    }
    moveTo(rows, 1);
    resetStyle();
  };

  render();
  hideCursor();

  return new Promise<string | null>((resolve) => {
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();

    const cleanup = () => {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("keypress", onKey);
      showCursor();
      clearScreen();
      moveTo(1, 1);
    };

    const onKey = (_str: string, key: any) => {
      if (key.name === "up") {
        if (selected > 0) { selected--; if (selected < scroll) scroll--; render(); }
      } else if (key.name === "down") {
        if (selected < sessions.length - 1) { selected++; if (selected >= scroll + listHeight) scroll++; render(); }
      } else if (key.name === "return" || key.name === "enter") {
        cleanup();
        resolve(sessions[selected].id);
      } else if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        cleanup();
        resolve(null);
      }
    };

    process.stdin.on("keypress", onKey);
  });
}
