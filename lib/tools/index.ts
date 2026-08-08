export * from "./exec-tools.ts";
export * from "./fs-tools.ts";
export * from "./background-jobs.ts";
export * from "./web-tools.ts";
export * from "./search-tools.ts";
export * from "./git-tools.ts";
export * from "./delegate-tool.ts";
export * from "./gh-tools.ts";
export * from "../indexer.ts";
export * from "../subagents.ts";
export * from "../mcp.ts";
export * from "../vuln.ts";

import { executeBash } from "./exec-tools.ts";
import { readFile, readFiles, writeFile, editFile, listDir, globFilesTool } from "./fs-tools.ts";
import { runBackgroundCommand, getBackgroundOutput, killBackgroundJob } from "./background-jobs.ts";
import { webFetch, todoWrite } from "./web-tools.ts";
import { grepSearch } from "./search-tools.ts";
import { gitCommit, gitStatus, gitAdd, gitDiff, gitLog, gitRestore } from "./git-tools.ts";
import { delegateTask } from "./delegate-tool.ts";
import { ghPr, ghIssue, ghComment } from "./gh-tools.ts";
import { semanticSearchTool } from "../indexer.ts";
import { delegateToAgent } from "../subagents.ts";
import { vulnScanTool } from "../vuln.ts";
import { recordAudit } from "../audit.ts";

function wrapToolWithMalformedGuard(tool: any) {
  const originalExecute = tool.execute.bind(tool);
  tool.execute = async (args: any, context: any) => {
    const start = Date.now();
    if (args && (args.__malformed_arguments || args.error?.includes("malformed"))) {
      const raw = args.__malformed_arguments || JSON.stringify(args);
      recordAudit(tool.name, args, "error", Date.now() - start);
      return {
        status: "error",
        message: `INVALID TOOL CALL: Arguments were malformed JSON and could not be parsed. Raw input received: "${raw}". Please reissue this tool call with strict JSON formatting.`
      };
    }
    // Global error boundary: a throw in any tool must never crash the turn.
    // Catch it and return a structured error the model can act on.
    try {
      const result = await originalExecute(args, context);
      recordAudit(tool.name, args, result?.status || "ok", Date.now() - start);
      return result;
    } catch (err: any) {
      recordAudit(tool.name, args, "error", Date.now() - start);
      return {
        status: "error",
        message: `Tool "${tool.name}" failed: ${err?.message || String(err)}. Please check your arguments and try again, or try a different approach.`,
      };
    }
  };
  return tool;
}

// Same order as the original monolithic tools array in cli.ts.
export const allTools = [
  executeBash,
  readFile,
  readFiles,
  writeFile,
  editFile,
  listDir,
  globFilesTool,
  grepSearch,
  gitCommit,
  gitStatus,
  gitAdd,
  gitDiff,
  gitLog,
  gitRestore,
  runBackgroundCommand,
  getBackgroundOutput,
  killBackgroundJob,
  webFetch,
  todoWrite,
  delegateTask,
  semanticSearchTool,
  ghPr,
  ghIssue,
  ghComment,
  delegateToAgent,
  vulnScanTool,
].map(wrapToolWithMalformedGuard);

