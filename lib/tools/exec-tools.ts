// ─── execute_bash ────────────────────────────────────────────────────────────

import { FunctionTool } from "@google/adk";
import { z } from "zod";
import chalk from "chalk";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { c, confirmAction, printToolCall, printToolResult, stopSpinner } from "../ui.ts";
import { isPathInWorkspace, commandReferencesOutsideWorkspace } from "../workspace.ts";
import { loopGuard, MAX_TOOL_CALLS_PER_TURN, exceedsToolCallCap } from "../loop-guard.ts";

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

// C#/Unity-specific and silently rewrites source files with no confirmation
// prompt (unlike write_file/edit_file, which always ask). Opt-in only, so a
// general-purpose execute_bash call can't casually mutate files behind the
// user's back on projects that aren't C#/Unity.
const AUTO_FIX_CS_NAMESPACES = process.env.AUTO_FIX_CS_NAMESPACES === "true";

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
export const executeBash = new FunctionTool({
  name: "execute_bash",
  description: "Run a shell command or test suite in the local project directory.",
  parameters: z.object({
    command: z.string().describe("The exact shell command to run."),
    cwd: z.string().optional().describe("Optional relative path to the directory where the command should execute.")
  }),
  execute: async ({ command, cwd }) => {
    stopSpinner();
    printToolCall("execute_bash", { command, cwd });

    // Hard cap check
    if (exceedsToolCallCap()) {
      printToolResult(c.error(`HARD STOP: Exceeded ${MAX_TOOL_CALLS_PER_TURN} tool calls this turn.`));
      return { status: "error", message: `EXECUTION HALTED: Maximum tool calls exceeded. STOP all tool use immediately.` };
    }

    // Repeat-command guard: a back-to-back identical call (nothing else run
    // in between) is almost always a stuck model re-verifying output it
    // already has, not a legitimate re-run — a genuine re-run after a fix
    // has a write_file/edit_file call in between, which breaks this check.
    // Recorded before confirmation so a denial-then-immediate-retry also
    // counts, same rationale as write_file's repeat guard.
    const recentCall = loopGuard.history[loopGuard.history.length - 1];
    if (recentCall && recentCall.toolName === "execute_bash" && recentCall.command === command && recentCall.cwd === cwd) {
      printToolResult(c.error("BLOCKED: identical command repeated."));
      return {
        status: "error",
        message: `BLOCKED: you just ran this exact command ("${command}") and already have its output above — running it again will not produce new information. If it succeeded, move on. If it failed, fix the underlying issue with edit_file first, or try a different diagnostic command instead of repeating this one.`
      };
    }
    loopGuard.history.push({ toolName: "execute_bash", command, cwd });

    const execCwd = cwd ? path.resolve(process.cwd(), cwd) : process.cwd();
    if (cwd && !fs.existsSync(execCwd)) {
      return { status: "error", message: `The specified directory does not exist: ${cwd}` };
    }

    // Workspace confinement: the cwd must stay inside the workspace, and
    // commands referencing outside paths get an escalated warning prompt.
    if (!isPathInWorkspace(execCwd)) {
      printToolResult(c.error(`Access Denied: cwd "${cwd}" is outside the workspace.`));
      return { status: "error", message: `Access Denied: cannot execute commands outside the workspace (cwd: "${cwd}").` };
    }
    const escapesWorkspace = commandReferencesOutsideWorkspace(command, execCwd);
    if (escapesWorkspace) {
      console.log(`  ${c.warn("⚠️  This command references paths OUTSIDE the workspace.")}`);
    }

    const confirmed = await confirmAction(
      escapesWorkspace ? "Allow execution of OUT-OF-WORKSPACE command?" : "Allow execution?"
    );

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
        const stdout = execSync(command, { encoding: "utf-8", timeout: 120000, cwd: execCwd });
        runStdout = stdout;
        succeeded = true;
        break;
      } catch (error: any) {
        runStdout = error.stdout || "";
        runStderr = error.stderr || "";
        const fullOutput = runStdout + "\n" + runStderr + "\n" + (error.message || "");

        // Try local namespace auto-fix pre-pass (costs 0 tokens!) — opt-in via
        // AUTO_FIX_CS_NAMESPACES=true, since it rewrites files unprompted.
        const fixed = AUTO_FIX_CS_NAMESPACES && autoFixMissingNamespaces(fullOutput);
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
