export * from "./exec-tools.ts";
export * from "./fs-tools.ts";
export * from "./background-jobs.ts";
export * from "./web-tools.ts";
export * from "./search-tools.ts";
export * from "./git-tools.ts";

import { executeBash } from "./exec-tools.ts";
import { readFile, readFiles, writeFile, editFile, listDir, globFilesTool } from "./fs-tools.ts";
import { runBackgroundCommand, getBackgroundOutput, killBackgroundJob } from "./background-jobs.ts";
import { webFetch, todoWrite } from "./web-tools.ts";
import { grepSearch } from "./search-tools.ts";
import { gitCommit, gitStatus, gitAdd, gitDiff, gitLog, gitRestore } from "./git-tools.ts";

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
];
