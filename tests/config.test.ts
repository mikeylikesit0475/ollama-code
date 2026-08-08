import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { loadCustomCommands } from "../lib/config.ts";

// loadCustomCommands reads <cwd>/.ollama-code.json. We write a temp config,
// assert, then clean up.
function withConfig(cfg: any, fn: () => void) {
  const cfgPath = path.join(process.cwd(), ".ollama-code.json");
  const had = fs.existsSync(cfgPath);
  const backup = had ? fs.readFileSync(cfgPath, "utf-8") : null;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg), "utf-8");
  try {
    fn();
  } finally {
    if (had) fs.writeFileSync(cfgPath, backup!, "utf-8");
    else { try { fs.unlinkSync(cfgPath); } catch { /* already gone */ } }
  }
}

test("config: loads custom commands with {input} template", () => {
  withConfig({
    commands: [
      { name: "lint", description: "Run the linter", prompt: "Run the linter. {input}" },
      { name: "test", prompt: "Run tests for {input}" },
    ],
  }, () => {
    const cmds = loadCustomCommands();
    assert.equal(cmds.length, 2);
    assert.equal(cmds[0].name, "lint");
    assert.ok(cmds[0].prompt.includes("{input}"));
    assert.equal(cmds[1].name, "test");
  });
});

test("config: strips leading slash from command names", () => {
  withConfig({ commands: [{ name: "/deploy", prompt: "Deploy {input}" }] }, () => {
    const cmds = loadCustomCommands();
    assert.equal(cmds[0].name, "deploy");
  });
});

test("config: ignores malformed command entries", () => {
  withConfig({ commands: [{ name: "ok", prompt: "fine" }, { name: "no-prompt" }, { prompt: "no-name" }] }, () => {
    const cmds = loadCustomCommands();
    assert.equal(cmds.length, 1);
    assert.equal(cmds[0].name, "ok");
  });
});

test("config: no config file returns empty commands", () => {
  const cfgPath = path.join(process.cwd(), ".ollama-code.json");
  const had = fs.existsSync(cfgPath);
  const backup = had ? fs.readFileSync(cfgPath, "utf-8") : null;
  if (had) fs.unlinkSync(cfgPath);
  try {
    assert.deepEqual(loadCustomCommands(), []);
  } finally {
    if (backup) fs.writeFileSync(cfgPath, backup, "utf-8");
  }
});
