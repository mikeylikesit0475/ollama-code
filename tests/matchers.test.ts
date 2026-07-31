import { test } from "node:test";
import assert from "node:assert/strict";
import { globToRegex, findFuzzyMatch } from "../lib/matchers.ts";

// ─── globToRegex ────────────────────────────────────────────────────────────

test("glob: exact filename matches only itself", () => {
  const re = globToRegex("cli.ts");
  assert.ok(re.test("cli.ts"));
  assert.ok(!re.test("cli.ts.bak"));
  assert.ok(!re.test("other.ts"));
});

test("glob: single star does not cross directory separators", () => {
  const re = globToRegex("*.ts");
  assert.ok(re.test("cli.ts"));
  assert.ok(re.test("agent.ts"));
  assert.ok(!re.test("src/cli.ts"));
  assert.ok(!re.test("cli.js"));
});

test("glob: double star crosses directories", () => {
  const re = globToRegex("**/*.ts");
  assert.ok(re.test("cli.ts"));
  assert.ok(re.test("src/cli.ts"));
  assert.ok(re.test("src/deep/nested/cli.ts"));
  assert.ok(!re.test("src/cli.js"));
});

test("glob: **/ matches zero directories", () => {
  const re = globToRegex("src/**/*.ts");
  assert.ok(re.test("src/cli.ts")); // zero intermediate dirs
  assert.ok(re.test("src/a/b/cli.ts"));
  assert.ok(!re.test("lib/cli.ts"));
});

test("glob: question mark matches exactly one character", () => {
  const re = globToRegex("cli.?s");
  assert.ok(re.test("cli.ts"));
  assert.ok(!re.test("cli.s"));
  assert.ok(!re.test("cli.tts"));
  assert.ok(!re.test("cli//s"));
});

test("glob: regex metacharacters are treated literally", () => {
  const re = globToRegex("file(1).ts");
  assert.ok(re.test("file(1).ts"));
  assert.ok(!re.test("file1.ts"));
});

test("glob: dots are literal, not wildcards", () => {
  const re = globToRegex("a.c");
  assert.ok(re.test("a.c"));
  assert.ok(!re.test("abc"));
});

// ─── findFuzzyMatch ─────────────────────────────────────────────────────────

test("fuzzy: exact match returns correct range", () => {
  const content = "hello world foo bar";
  const result = findFuzzyMatch(content, "world foo");
  assert.deepEqual(result, { start: 6, end: 15 });
  assert.equal(content.slice(result!.start, result!.end), "world foo");
});

test("fuzzy: whitespace differences are tolerated", () => {
  const content = "if (x) {\n    return 1;\n}";
  const result = findFuzzyMatch(content, "if (x) { return 1; }");
  assert.ok(result !== null);
  assert.equal(content.slice(result.start, result.end), content);
});

test("fuzzy: tabs vs spaces are tolerated", () => {
  const content = "const x = {\n\tkey: 1\n};";
  const result = findFuzzyMatch(content, "const x = {\n  key: 1\n};");
  assert.ok(result !== null);
});

test("fuzzy: returns null when target is absent", () => {
  assert.equal(findFuzzyMatch("hello world", "goodbye"), null);
});

test("fuzzy: returns null when match is ambiguous", () => {
  const content = "foo bar foo bar";
  assert.equal(findFuzzyMatch(content, "foo bar"), null);
});

test("fuzzy: regex metacharacters in target are literal", () => {
  const content = "const re = /a+b/; let x = 1;";
  const result = findFuzzyMatch(content, "/a+b/");
  assert.ok(result !== null);
  assert.equal(content.slice(result.start, result.end), "/a+b/");
});

test("fuzzy: multiline target with indentation", () => {
  const content = [
    "function main() {",
    "  const a = 1;",
    "  const b = 2;",
    "  return a + b;",
    "}",
  ].join("\n");
  const target = "const a = 1;\n  const b = 2;";
  const result = findFuzzyMatch(content, target);
  assert.ok(result !== null);
  assert.equal(
    content.slice(result.start, result.end),
    "const a = 1;\n  const b = 2;"
  );
});
