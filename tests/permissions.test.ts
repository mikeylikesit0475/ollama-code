import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { checkPermission, reloadPermissions } from "../lib/permissions.ts";

// The permissions module reads config from <cwd>/.ollama-code.json. We write a
// temp config, reload, and assert the decisions, then clean up.
function withConfig(perms: any, fn: () => void) {
  const cfgPath = path.join(process.cwd(), ".ollama-code.json");
  const had = fs.existsSync(cfgPath);
  const backup = had ? fs.readFileSync(cfgPath, "utf-8") : null;
  fs.writeFileSync(cfgPath, JSON.stringify({ permissions: perms }), "utf-8");
  reloadPermissions();
  try {
    fn();
  } finally {
    if (had) fs.writeFileSync(cfgPath, backup!, "utf-8");
    else { try { fs.unlinkSync(cfgPath); } catch { /* already gone */ } }
    reloadPermissions();
  }
}

test("permissions: bare tool name allow rule", () => {
  withConfig({ allow: ["git_status"] }, () => {
    assert.equal(checkPermission("git_status"), "allow");
    assert.equal(checkPermission("git_diff"), "ask");
  });
});

test("permissions: deny rule with command pattern", () => {
  withConfig({ deny: ["execute_bash:rm -rf"] }, () => {
    assert.equal(checkPermission("execute_bash", { command: "rm -rf /" }), "deny");
    assert.equal(checkPermission("execute_bash", { command: "ls -la" }), "ask");
  });
});

test("permissions: allow rule with path glob", () => {
  withConfig({ allow: ["read_file:src/*"] }, () => {
    assert.equal(checkPermission("read_file", { path: "src/App.tsx" }), "allow");
    assert.equal(checkPermission("read_file", { path: "tests/x.test.ts" }), "ask");
  });
});

test("permissions: deny takes precedence over allow", () => {
  withConfig({ allow: ["execute_bash"], deny: ["execute_bash:rm -rf"] }, () => {
    assert.equal(checkPermission("execute_bash", { command: "rm -rf /" }), "deny");
    assert.equal(checkPermission("execute_bash", { command: "ls" }), "allow");
  });
});

test("permissions: no config defaults to ask", () => {
  const cfgPath = path.join(process.cwd(), ".ollama-code.json");
  const had = fs.existsSync(cfgPath);
  const backup = had ? fs.readFileSync(cfgPath, "utf-8") : null;
  if (had) fs.unlinkSync(cfgPath);
  reloadPermissions();
  try {
    assert.equal(checkPermission("write_file", { path: "x.ts" }), "ask");
  } finally {
    if (backup) fs.writeFileSync(cfgPath, backup, "utf-8");
    reloadPermissions();
  }
});
