// ─── read_file, read_files, write_file, edit_file, list_dir, glob_files ─────

import { FunctionTool } from "@google/adk";
import { z } from "zod";
import fs from "fs";
import path from "path";
import { findFuzzyMatch } from "../matchers.ts";
import { c, confirmAction, printDiff, printToolCall, printToolResult, stopSpinner } from "../ui.ts";
import { isPathInWorkspace, globFiles, listDirRecursive, GLOB_MAX_RESULTS } from "../workspace.ts";
import { loopGuard, MAX_TOOL_CALLS_PER_TURN, exceedsToolCallCap } from "../loop-guard.ts";

// Shared by read_file and read_files: guards against a single tool call
// reading a huge file (e.g. 50MB) entirely into memory, and against returning
// enough text to blow a 16k-context local model's window in one shot.
const MAX_READABLE_FILE_BYTES = 25 * 1024 * 1024; // 25 MB
const MAX_READ_RESULT_CHARS = 100_000; // ~25k tokens

function readFileCapped(fullPath: string, startLine?: number, endLine?: number) {
  const stat = fs.statSync(fullPath);
  if (stat.size > MAX_READABLE_FILE_BYTES) {
    return {
      status: "error",
      message: `File is too large to read (${(stat.size / (1024 * 1024)).toFixed(1)} MB, limit ${MAX_READABLE_FILE_BYTES / (1024 * 1024)} MB). Use startLine/endLine to read a bounded slice, or grep_search to locate the relevant section first.`
    };
  }

  const content = fs.readFileSync(fullPath, "utf-8");
  const lines = content.split("\n");
  const start = startLine !== undefined ? Math.max(1, startLine) - 1 : 0;
  const end = endLine !== undefined ? Math.min(lines.length, endLine) : lines.length;
  let sliced = lines.slice(start, end).join("\n");

  const result: any = { status: "success", content: sliced, totalLines: lines.length, startLine: start + 1, endLine: end };
  if (sliced.length > MAX_READ_RESULT_CHARS) {
    result.content = sliced.slice(0, MAX_READ_RESULT_CHARS);
    result.truncated = true;
    result.message = `Content truncated to ${MAX_READ_RESULT_CHARS} characters. Use startLine/endLine to read a smaller range.`;
  }
  return result;
}

// Tool 2: read_file (non-interactive)
export const readFile = new FunctionTool({
  name: "read_file",
  description: "Safely read the text content of a local project file.",
  parameters: z.object({
    path: z.string().describe("Relative path to the target file."),
    startLine: z.number().optional().describe("Optional 1-indexed starting line to read (inclusive)."),
    endLine: z.number().optional().describe("Optional 1-indexed ending line to read (inclusive).")
  }),
  execute: async ({ path: filePath, startLine, endLine }) => {
    try {
      const fullPath = path.resolve(filePath);
      if (!isPathInWorkspace(fullPath)) {
        return { status: "error", message: `Access Denied: "${filePath}" is outside the workspace.` };
      }
      return readFileCapped(fullPath, startLine, endLine);
    } catch (error: any) {
      stopSpinner();
      printToolResult(c.error(`Error reading ${filePath}: ${error.message}`));
      return { status: "error", message: error.message };
    }
  }
});

// Tool 12: read_files (non-interactive)
export const readFiles = new FunctionTool({
  name: "read_files",
  description: "Safely read the text content of multiple local project files at once.",
  parameters: z.object({
    paths: z.array(z.string()).describe("List of relative paths to the target files.")
  }),
  execute: async ({ paths: filePaths }) => {
    const results: Record<string, any> = {};
    for (const filePath of filePaths) {
      try {
        const fullPath = path.resolve(filePath);
        if (!isPathInWorkspace(fullPath)) {
          results[filePath] = { status: "error", message: `Access Denied: "${filePath}" is outside the workspace.` };
          continue;
        }
        results[filePath] = readFileCapped(fullPath);
      } catch (error: any) {
        results[filePath] = { status: "error", message: error.message };
      }
    }
    return results;
  }
});

// Tool 3: write_file with inline confirmation and loop guard
export const writeFile = new FunctionTool({
  name: "write_file",
  description: "Create a new file or completely overwrite an existing file at a specified path. WARNING: Avoid using write_file to edit existing files or correct syntax errors as it often introduces new typos; instead, use edit_file to make targeted edits.",
  parameters: z.object({
    path: z.string().describe("Relative path to the target file."),
    content: z.string().describe("The exact text content to write to the file.")
  }),
  execute: async ({ path: filePath, content }) => {
    stopSpinner();
    printToolCall("write_file", { path: filePath });

    // Hard cap: if total tool calls exceeded, halt immediately
    if (exceedsToolCallCap()) {
      printToolResult(c.error(`HARD STOP: Exceeded ${MAX_TOOL_CALLS_PER_TURN} tool calls this turn. Halting execution.`));
      return {
        status: "error",
        message: `EXECUTION HALTED: You have exceeded the maximum of ${MAX_TOOL_CALLS_PER_TURN} tool calls per user turn. STOP all tool use immediately. Summarize what you have accomplished so far and wait for the user's next instruction.`
      };
    }

    const fullPath = path.resolve(filePath);

    if (!isPathInWorkspace(fullPath)) {
      printToolResult(c.error(`Access Denied: "${filePath}" is outside the workspace.`));
      return { status: "error", message: `Access Denied: "${filePath}" is outside the workspace.` };
    }

    // Hard repeat-write guard (Ticket 3): a path may be fully written at most
    // ONCE per turn. A second write_file to the same path is rejected and the
    // model is told to use edit_file. (Does NOT halt the loop guard — let the
    // turn continue so the model can switch to edit_file.)
    const duplicateWrites = loopGuard.history.filter(
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
    loopGuard.history.push({ toolName: "write_file", targetPath: fullPath });

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
export const editFile = new FunctionTool({
  name: "edit_file",
  description: "Make one or more precise modifications to an existing file by replacing unique blocks of text (oldText) with new blocks of text (newText). Prefer this tool over write_file when modifying existing files.",
  parameters: z.object({
    path: z.string().describe("Relative path to the file to modify."),
    oldText: z.string().optional().describe("The exact, unique block of text to be replaced (omit if using 'edits')."),
    newText: z.string().optional().describe("The new block of text to replace it with (omit if using 'edits')."),
    edits: z.array(z.object({
      oldText: z.string().describe("The exact, unique block of text to be replaced."),
      newText: z.string().describe("The new block of text to replace it with.")
    })).optional().describe("An optional list of multiple non-overlapping modifications to apply at once."),
    dryRun: z.boolean().optional().describe("If true, only checks if the targets exist uniquely and returns diff previews without writing to disk or prompting for confirmation.")
  }),
  execute: async ({ path: filePath, oldText, newText, edits, dryRun }) => {
    stopSpinner();
    printToolCall("edit_file", { path: filePath, dryRun });

    // Hard cap check
    if (exceedsToolCallCap()) {
      printToolResult(c.error(`HARD STOP: Exceeded ${MAX_TOOL_CALLS_PER_TURN} tool calls this turn.`));
      return { status: "error", message: `EXECUTION HALTED: Maximum tool calls exceeded. STOP all tool use immediately.` };
    }

    const fullPath = path.resolve(filePath);
    const relativeDisplayPath = path.relative(process.cwd(), fullPath) || filePath;

    if (!isPathInWorkspace(fullPath)) {
      printToolResult(c.error(`Access Denied: "${filePath}" is outside the workspace.`));
      return { status: "error", message: `Access Denied: "${filePath}" is outside the workspace.` };
    }

    // Check file existence first
    if (!fs.existsSync(fullPath)) {
      printToolResult(c.error(`Error: File does not exist: ${relativeDisplayPath}`));
      return { status: "error", message: `File does not exist: ${filePath}` };
    }

    const fileContent = fs.readFileSync(fullPath, "utf-8");

    // Standardize input into a single array of edits
    const editsToApply = edits || [];
    if (oldText !== undefined && newText !== undefined) {
      editsToApply.push({ oldText, newText });
    }

    if (editsToApply.length === 0) {
      return { status: "error", message: "No edits specified. Please provide 'oldText' and 'newText', or an 'edits' list." };
    }

    // First pass: validate all edits exist uniquely in the current fileContent
    const matchedRanges: { start: number; end: number; oldText: string; newText: string; isFuzzy: boolean }[] = [];

    for (const edit of editsToApply) {
      let occurrences = fileContent.split(edit.oldText).length - 1;
      let startIdx = -1;
      let endIdx = -1;
      let isFuzzy = false;

      if (occurrences === 0) {
        const fuzzy = findFuzzyMatch(fileContent, edit.oldText);
        if (fuzzy) {
          occurrences = 1;
          startIdx = fuzzy.start;
          endIdx = fuzzy.end;
          isFuzzy = true;
        }
      } else {
        startIdx = fileContent.indexOf(edit.oldText);
        endIdx = startIdx + edit.oldText.length;
      }

      if (occurrences === 0) {
        printToolResult(c.error(`oldText not found: "${edit.oldText}"`));
        return {
          status: "error",
          message: `Could not find the target oldText in the file: "${edit.oldText}". Make sure spelling, whitespace, and formatting match exactly.`
        };
      }
      if (occurrences > 1) {
        printToolResult(c.error(`Multiple matches for: "${edit.oldText}"`));
        return {
          status: "error",
          message: `Found multiple occurrences of the target oldText: "${edit.oldText}". Please include more surrounding context lines to make it unique.`
        };
      }

      matchedRanges.push({ start: startIdx, end: endIdx, oldText: edit.oldText, newText: edit.newText, isFuzzy });
    }

    // Dry Run
    if (dryRun) {
      for (const edit of editsToApply) {
        printDiff(edit.oldText, edit.newText);
      }
      printToolResult(c.meta(`[Dry Run Diff Preview Generated Successfully for ${editsToApply.length} edits]`));
      return {
        status: "success",
        message: `Dry run successful. All targets found. computed diffs generated.`
      };
    }

    // Repeat-edit guard (Ticket 3) - only check first edit for simplicity
    if (editsToApply.length === 1) {
      const recent = loopGuard.history[loopGuard.history.length - 1];
      if (recent && recent.toolName === "edit_file" && recent.targetPath === fullPath && recent.oldText === editsToApply[0].oldText) {
        printToolResult(c.error("BLOCKED: identical edit repeated."));
        return {
          status: "error",
          message: `BLOCKED: you just attempted the exact same edit to "${filePath}" and it failed. Call read_file first.`
        };
      }
      loopGuard.history.push({ toolName: "edit_file", targetPath: fullPath, oldText: editsToApply[0].oldText });
    }

    // Print all diffs to console
    for (const edit of editsToApply) {
      printDiff(edit.oldText, edit.newText);
    }

    const confirmed = await confirmAction(`Apply ${editsToApply.length} changes to ${relativeDisplayPath}?`);

    if (!confirmed) {
      printToolResult("Denied by user.");
      return { status: "denied", message: "User aborted file edit operation." };
    }

    try {
      // Sort matched ranges in descending order by start index so we apply back-to-front
      // without invalidating indices!
      matchedRanges.sort((a, b) => b.start - a.start);

      let updatedContent = fileContent;
      for (const range of matchedRanges) {
        if (range.isFuzzy) {
          console.log(`  ${c.warn("⚡ Warning: Matched oldText with fuzzy whitespace normalization.")}`);
        }
        updatedContent = updatedContent.substring(0, range.start) + range.newText + updatedContent.substring(range.end);
      }

      fs.writeFileSync(fullPath, updatedContent, "utf-8");
      printToolResult(c.success(`✓ Modified ${relativeDisplayPath} (${editsToApply.length} edits)`));
      return { status: "success", message: `Successfully modified ${filePath} with ${editsToApply.length} edits.` };
    } catch (error: any) {
      printToolResult(c.error(`Error editing ${relativeDisplayPath}: ${error.message}`));
      return { status: "error", message: error.message };
    }
  }
});

// Tool 5: list_dir (non-interactive)
export const listDir = new FunctionTool({
  name: "list_dir",
  description: "Recursively list files in the current workspace, ignoring node_modules and version control directories.",
  parameters: z.object({
    path: z.string().optional().describe("Relative path to listing start. Defaults to the root directory.")
  }),
  execute: async ({ path: startPath = "." }) => {
    try {
      const resolvedStart = path.resolve(startPath);
      if (!isPathInWorkspace(resolvedStart)) {
        return { status: "error", message: `Access Denied: "${startPath}" is outside the workspace.` };
      }
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

// Tool 5.5: glob_files (non-interactive)
export const globFilesTool = new FunctionTool({
  name: "glob_files",
  description: "Search for files in the project matching a glob pattern (e.g. '**/*.ts', 'src/**/*.js').",
  parameters: z.object({
    pattern: z.string().describe("The glob pattern to match.")
  }),
  execute: async ({ pattern }) => {
    try {
      const files = globFiles(pattern);
      const result: any = { status: "success", files };
      if (files.length >= GLOB_MAX_RESULTS) {
        result.truncated = true;
        result.message = `Result capped at ${GLOB_MAX_RESULTS} files. Narrow your glob pattern for a complete list.`;
      }
      return result;
    } catch (err: any) {
      return { status: "error", message: err.message };
    }
  }
});
