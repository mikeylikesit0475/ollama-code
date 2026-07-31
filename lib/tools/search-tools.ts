// ─── grep_search ─────────────────────────────────────────────────────────────

import { FunctionTool } from "@google/adk";
import { z } from "zod";
import { execFileSync, execSync } from "child_process";
import fs from "fs";
import { globFiles, listDirRecursive } from "../workspace.ts";

// Binary detection for the grep_search fallback path (git grep skips binaries
// natively; the manual walk below does not). Standard NUL-byte-in-prefix
// heuristic — same approach git/grep itself use.
function isLikelyBinaryFile(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(8000);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);
    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

const GREP_FALLBACK_MAX_FILE_BYTES = 5 * 1024 * 1024; // skip pathologically large files in the manual walk
const GREP_MAX_RESULT_LINES = 500; // cap what's returned to the model regardless of search path

// Tool 6: grep_search (non-interactive)
export const grepSearch = new FunctionTool({
  name: "grep_search",
  description: "Search for occurrences of a text pattern across the codebase.",
  parameters: z.object({
    query: z.string().describe("The search term or pattern to look for."),
    isRegex: z.boolean().optional().describe("If true, treats query as a regular expression pattern rather than a fixed string."),
    glob: z.string().optional().describe("A pattern-based glob filter for files (e.g. '*.ts', 'src/*')."),
    contextLines: z.number().optional().describe("Optional number of context lines to show around the match (maps to -C).")
  }),
  execute: async ({ query, isRegex, glob, contextLines }) => {
    try {
      let stdout = "";
      let isGit = false;
      try {
        execSync("git rev-parse --is-inside-work-tree", { stdio: "ignore" });
        isGit = true;
      } catch (e) {}

      if (isGit) {
        const args = ["grep", "-n"];
        if (!isRegex) {
          args.push("-F");
        }
        if (contextLines !== undefined) {
          args.push("-C", String(Math.max(0, contextLines)));
        }
        args.push("--", query);
        if (glob) {
          args.push(glob);
        }
        stdout = execFileSync("git", args, { encoding: "utf-8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] });
      } else {
        const files = glob ? globFiles(glob) : listDirRecursive(".");
        const matches: string[] = [];
        const regex = isRegex ? new RegExp(query) : null;
        outer:
        for (const file of files) {
          try {
            const stat = fs.statSync(file);
            if (stat.size > GREP_FALLBACK_MAX_FILE_BYTES || isLikelyBinaryFile(file)) continue;
          } catch {
            continue; // unreadable/gone since listing — skip rather than crash the whole search
          }
          const content = fs.readFileSync(file, "utf-8");
          const lines = content.split("\n");
          for (let index = 0; index < lines.length; index++) {
            const line = lines[index];
            const isMatch = regex ? regex.test(line) : line.includes(query);
            if (isMatch) {
              if (contextLines !== undefined && contextLines > 0) {
                const start = Math.max(0, index - contextLines);
                const end = Math.min(lines.length, index + contextLines + 1);
                for (let j = start; j < end; j++) {
                  const prefix = j === index ? "> " : "  ";
                  matches.push(`${file}:${j + 1}:${prefix}${lines[j]}`);
                }
                matches.push("---");
              } else {
                matches.push(`${file}:${index + 1}:${line}`);
              }
              // Bound worst-case scan cost once we're already well past what
              // will be returned — no point grepping the whole repo.
              if (matches.length > GREP_MAX_RESULT_LINES * 4) break outer;
            }
          }
        }
        stdout = matches.join("\n");
      }

      if (stdout) {
        const resultLines = stdout.split("\n");
        if (resultLines.length > GREP_MAX_RESULT_LINES) {
          stdout = resultLines.slice(0, GREP_MAX_RESULT_LINES).join("\n")
            + `\n... (truncated, showing first ${GREP_MAX_RESULT_LINES} of ${resultLines.length}+ lines — narrow your query or glob)`;
        }
      }
      return { status: "success", results: stdout || "No matches found." };
    } catch (error: any) {
      // git grep exits 1 when there are no matches — that's not an error.
      // Anything else (bad regex, unreadable files, git failure) is real.
      if (error.status === 1 && !error.stderr) {
        return { status: "success", results: "No matches found." };
      }
      const detail = error.stderr ? String(error.stderr).trim() : error.message;
      return { status: "error", message: `Search failed: ${detail}` };
    }
  }
});
