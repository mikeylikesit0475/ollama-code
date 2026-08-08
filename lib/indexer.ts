// ─── Repo Indexing + Semantic Search ─────────────────────────────────────────
// Builds a lightweight, on-demand embedding index of the workspace using
// Ollama's /api/embed endpoint, then exposes a `semantic_search` tool that
// finds the most relevant files/chunks for a natural-language query. This is
// the "workspace-aware" retrieval that grep/glob (lexical) can't provide.
//
// The index is built lazily on first use and cached in memory for the session.
// Chunks are capped in size and count so a large repo doesn't blow the model's
// context window or the embedding request.

import { FunctionTool } from "@google/adk";
import { z } from "zod";
import fs from "fs";
import path from "path";
import { globFiles } from "./workspace.ts";

const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";
const CHUNK_CHARS = 800;          // ~200 tokens per chunk
const MAX_FILES = 200;            // cap on files indexed per build
const MAX_CHUNKS_PER_FILE = 8;    // cap on chunks per file
const MAX_RESULTS = 5;            // chunks returned to the model

interface Chunk {
  file: string;
  text: string;
  embedding: number[];
}

let index: Chunk[] | null = null;
let indexError: string | null = null;

// Skip the same heavy/irrelevant dirs the rest of the tooling ignores.
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "bin", "obj", ".cache", ".config", ".vscode", ".ollama", ".ollama-code", ".gemini", "__pycache__"]);
const SKIP_FILES = new Set(["package-lock.json", ".env", ".env.save", "debug.json", "TODO.md", "MEMORY.md"]);

function isIndexableFile(relPath: string): boolean {
  const base = path.basename(relPath);
  if (SKIP_FILES.has(base)) return false;
  const ext = path.extname(base).toLowerCase();
  // Only index source/text-like files.
  return /\.(ts|tsx|js|jsx|py|go|rs|java|c|cpp|h|hpp|cs|rb|php|swift|kt|sh|json|md|yaml|yml|toml|sql|html|css|scss)$/.test(ext);
}

function chunkText(text: string): string[] {
  const lines = text.split("\n");
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    if (current.length + line.length + 1 > CHUNK_CHARS && current.trim()) {
      chunks.push(current.trim());
      current = "";
    }
    current += line + "\n";
    if (chunks.length >= MAX_CHUNKS_PER_FILE) break;
  }
  if (current.trim() && chunks.length < MAX_CHUNKS_PER_FILE) chunks.push(current.trim());
  return chunks;
}

async function embed(texts: string[], baseUrl: string): Promise<number[][]> {
  const res = await fetch(`${baseUrl}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });
  if (!res.ok) throw new Error(`embed failed: HTTP ${res.status}`);
  const data: any = await res.json();
  return data.embeddings || [];
}

// Build (or rebuild) the in-memory index. Returns a short status string.
export async function buildIndex(baseUrl: string): Promise<string> {
  try {
    const files = globFiles("**/*").filter(isIndexableFile).slice(0, MAX_FILES);
    if (files.length === 0) {
      index = [];
      return "No indexable source files found.";
    }

    const chunks: Chunk[] = [];
    for (const file of files) {
      try {
        const content = fs.readFileSync(file, "utf-8");
        for (const text of chunkText(content)) {
          chunks.push({ file, text, embedding: [] });
        }
      } catch {
        // skip unreadable files
      }
    }

    // Embed in batches to keep requests small.
    const BATCH = 16;
    for (let i = 0; i < chunks.length; i += BATCH) {
      const batch = chunks.slice(i, i + BATCH);
      const vectors = await embed(batch.map((c) => c.text), baseUrl);
      for (let j = 0; j < batch.length; j++) {
        batch[j].embedding = vectors[j] || [];
      }
    }

    index = chunks.filter((c) => c.embedding.length > 0);
    indexError = null;
    return `Indexed ${index.length} chunks across ${files.length} files (embed model: ${EMBED_MODEL}).`;
  } catch (err: any) {
    indexError = err.message;
    index = null;
    return `Indexing failed: ${err.message}`;
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Search the index for the chunks most relevant to a query. Returns a compact
// list of file + snippet pairs. Rebuilds the index on first use.
export async function semanticSearch(query: string, baseUrl: string): Promise<string> {
  if (!index) {
    const status = await buildIndex(baseUrl);
    if (!index) return `Semantic search unavailable: ${indexError || status}`;
  }
  try {
    const [queryVec] = await embed([query], baseUrl);
    if (!queryVec || queryVec.length === 0) return "Could not embed the query.";
    const scored = index
      .map((c) => ({ c, score: cosine(queryVec, c.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RESULTS);
    return scored
      .map(({ c, score }) => `[${c.file} (score ${score.toFixed(3)})]\n${c.text.slice(0, 300)}`)
      .join("\n\n---\n\n");
  } catch (err: any) {
    return `Semantic search failed: ${err.message}`;
  }
}

// Tool: semantic_search
export const semanticSearchTool = new FunctionTool({
  name: "semantic_search",
  description: "Search the codebase by meaning (embeddings) rather than exact text. Returns the most relevant file snippets for a natural-language query. Use when grep_search can't find what you need because the wording differs.",
  parameters: z.object({
    query: z.string().describe("A natural-language description of what you're looking for (e.g. 'where is the session persistence logic')."),
  }),
  execute: async ({ query }) => {
    const baseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
    const result = await semanticSearch(query, baseUrl);
    return { status: "success", results: result };
  },
});
