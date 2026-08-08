// ─── Post-Write Automated Verification Hook ───────────────────────────
// Performs fast, deterministic compiler/syntax verification on newly written
// or edited files to provide immediate feedback to the agent loop.

import fs from "fs";
import path from "path";
import { execFile } from "child_process";

const VERIFY_TIMEOUT_MS = 5000;

function runExec(cmd: string, args: string[], cwd: string, timeoutMs: number = VERIFY_TIMEOUT_MS): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs }, (error, stdout, stderr) => {
      const exitCode = error && typeof error.code === "number" ? error.code : (error ? 1 : 0);
      resolve({ exitCode, stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

/**
  * Runs fast post-write verification on a modified file.
  * Returns an error description if verification fails, or null if it passes/skips.
  */
export async function postWriteVerify(filePath: string, workspaceRoot: string): Promise<string | null> {
  const ext = path.extname(filePath).toLowerCase();
  const absolutePath = path.resolve(filePath);

  if (!fs.existsSync(absolutePath)) {
    return null;
  }

  // 1. JSON Verification
  if (ext === ".json") {
    try {
      const content = fs.readFileSync(absolutePath, "utf-8");
      JSON.parse(content);
      return null;
    } catch (e: any) {
      return `⚠️ Verification Notice: JSON syntax error in ${path.relative(workspaceRoot, absolutePath)}:\n${e.message}`;
    }
  }

  // 2. Python Verification (Syntax Check)
  if (ext === ".py") {
    const res = await runExec("python3", ["-m", "py_compile", absolutePath], workspaceRoot, 3000);
    if (res.exitCode !== 0) {
      const errOutput = (res.stderr || res.stdout).trim();
      return `⚠️ Verification Notice: Python syntax check failed for ${path.relative(workspaceRoot, absolutePath)}:\n${errOutput}`;
    }
    return null;
  }

  // 3. JavaScript Node Syntax Check
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    const res = await runExec("node", ["--check", absolutePath], workspaceRoot, 3000);
    if (res.exitCode !== 0) {
      const errOutput = (res.stderr || res.stdout).trim();
      return `⚠️ Verification Notice: JavaScript syntax check failed for ${path.relative(workspaceRoot, absolutePath)}:\n${errOutput}`;
    }
    return null;
  }

  // 4. TypeScript Type Check (if tsconfig.json present)
  if (ext === ".ts" || ext === ".tsx") {
    if (fs.existsSync(path.join(workspaceRoot, "tsconfig.json"))) {
      const res = await runExec("npx", ["tsc", "--noEmit"], workspaceRoot, VERIFY_TIMEOUT_MS);
      if (res.exitCode !== 0) {
        const errLines = (res.stdout || res.stderr).split("\n").filter(line => line.includes(path.basename(absolutePath))).slice(0, 5).join("\n");
        if (errLines.trim()) {
          return `⚠️ Verification Notice: TypeScript errors found after editing ${path.relative(workspaceRoot, absolutePath)}:\n${errLines.trim()}`;
        }
      }
    }
    return null;
  }

  // 5. Java Compile Check (if pom.xml present)
  if (ext === ".java") {
    let currentDir = path.dirname(absolutePath);
    let pomDir: string | null = null;

    while (currentDir.startsWith(workspaceRoot)) {
      if (fs.existsSync(path.join(currentDir, "pom.xml"))) {
        pomDir = currentDir;
        break;
      }
      const parent = path.dirname(currentDir);
      if (parent === currentDir) break;
      currentDir = parent;
    }

    if (pomDir) {
      const mvnCmd = process.env.MAVEN_HOME ? path.join(process.env.MAVEN_HOME, "bin", "mvn") : "mvn";
      const res = await runExec(mvnCmd, ["compile", "-q"], pomDir, 8000);
      if (res.exitCode !== 0) {
        const errOutput = (res.stderr || res.stdout).split("\n").filter(l => l.includes("ERROR") || l.includes(".java:")).slice(0, 6).join("\n");
        if (errOutput.trim()) {
          return `⚠️ Verification Notice: Java compilation failed after editing ${path.relative(workspaceRoot, absolutePath)}:\n${errOutput.trim()}`;
        }
      }
    }
    return null;
  }

  return null;
}
