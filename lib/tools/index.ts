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

function wrapToolWithMalformedGuard(tool: any) {
  const originalExecute = tool.execute.bind(tool);
  tool.execute = async (args: any, context: any) => {
    if (args && (args.__malformed_arguments || args.error?.includes("malformed"))) {
      const raw = args.__malformed_arguments || JSON.stringify(args);
      return {
        status: "error",
        message: `INVALID TOOL CALL: Arguments were malformed JSON and could not be parsed. Raw input received: "${raw}". Please reissue this tool call with strict JSON formatting.`
      };
    }
    return originalExecute(args, context);
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
].map(wrapToolWithMalformedGuard);

