// ─── MCP Client ───────────────────────────────────────────────────────────────
// Connects to external MCP (Model Context Protocol) servers and exposes their
// tools to the agent. This unlocks the whole MCP ecosystem (filesystem, GitHub,
// browser, databases, etc.) without hand-rolling each integration.
//
// Servers are configured in the config file:
//   {
//     "mcpServers": {
//       "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] },
//       "fs":     { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"] }
//     }
//   }
//
// Each server is spawned as a child process (stdio transport). Its tools are
// discovered via tools/list and wrapped as ADK FunctionTools that call
// tools/call. The client is lazy: servers connect on first use.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { FunctionTool } from "@google/adk";
import { z } from "zod";
import fs from "fs";
import path from "path";

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: any;
}

interface McpConnection {
  serverName: string;
  client: Client;
  transport: StdioClientTransport;
  tools: McpTool[];
}

const connections = new Map<string, McpConnection>();

function loadServerConfigs(): Record<string, McpServerConfig> {
  const candidates = [
    path.join(process.cwd(), ".ollama-code.json"),
    path.join(process.env.HOME || process.cwd(), ".ollama-code", "config.json"),
  ];
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
        const servers = raw?.mcpServers;
        if (servers && typeof servers === "object") return servers;
      }
    } catch {
      // ignore corrupt config
    }
  }
  return {};
}

// Connect to a server (idempotent). Returns the connection or throws.
async function connect(serverName: string): Promise<McpConnection> {
  const existing = connections.get(serverName);
  if (existing) return existing;

  const configs = loadServerConfigs();
  const cfg = configs[serverName];
  if (!cfg) throw new Error(`MCP server "${serverName}" is not configured.`);

  const transport = new StdioClientTransport({
    command: cfg.command,
    args: cfg.args || [],
    env: { ...process.env, ...(cfg.env || {}) },
  });
  const client = new Client({ name: "ollama-code", version: "1.0.0" });
  await client.connect(transport);

  const toolsResult = await client.listTools();
  const tools: McpTool[] = (toolsResult.tools || []).map((t: any) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));

  const conn: McpConnection = { serverName, client, transport, tools };
  connections.set(serverName, conn);
  return conn;
}

// Convert an MCP JSON schema to a zod schema (best-effort; falls back to a
// permissive object schema when the shape is unknown).
function zodFromSchema(schema: any): z.ZodType {
  if (!schema || schema.type !== "object" || !schema.properties) {
    return z.record(z.any());
  }
  const shape: Record<string, z.ZodType> = {};
  for (const [key, prop] of Object.entries<any>(schema.properties)) {
    switch (prop.type) {
      case "string": shape[key] = z.string().optional(); break;
      case "number": shape[key] = z.number().optional(); break;
      case "integer": shape[key] = z.number().optional(); break;
      case "boolean": shape[key] = z.boolean().optional(); break;
      case "array": shape[key] = z.array(z.any()).optional(); break;
      case "object": shape[key] = z.record(z.any()).optional(); break;
      default: shape[key] = z.any().optional();
    }
  }
  return z.object(shape);
}

// Build an ADK FunctionTool for a single MCP tool.
function wrapMcpTool(conn: McpConnection, tool: McpTool): FunctionTool {
  return new FunctionTool({
    name: `${conn.serverName}_${tool.name}`,
    description: `[MCP:${conn.serverName}] ${tool.description || tool.name}`,
    parameters: zodFromSchema(tool.inputSchema),
    execute: async (args: any) => {
      try {
        const result = await conn.client.callTool({
          name: tool.name,
          arguments: args || {},
        });
        // MCP returns content as a list of { type, text } blocks.
        const content = (result as any)?.content || [];
        const text = content
          .map((c: any) => (c.type === "text" ? c.text : JSON.stringify(c)))
          .join("\n");
        return { status: "success", result: text };
      } catch (err: any) {
        return { status: "error", message: err.message };
      }
    },
  });
}

// Connect to all configured servers and return their tools as ADK FunctionTools.
// Returns [] if none are configured or all fail to connect.
export async function loadMcpTools(): Promise<FunctionTool[]> {
  const configs = loadServerConfigs();
  const names = Object.keys(configs);
  if (names.length === 0) return [];

  const tools: FunctionTool[] = [];
  for (const name of names) {
    try {
      const conn = await connect(name);
      for (const t of conn.tools) {
        tools.push(wrapMcpTool(conn, t));
      }
    } catch (err: any) {
      console.error(`  ${"\x1b[33m"}⚠️ MCP server "${name}" failed to connect: ${err.message}${"\x1b[0m"}`);
    }
  }
  return tools;
}

// Disconnect all MCP servers (called on exit).
export async function closeMcpConnections(): Promise<void> {
  for (const conn of connections.values()) {
    try {
      await conn.client.close();
      conn.transport.close();
    } catch {
      // ignore
    }
  }
  connections.clear();
}

// List configured MCP server names.
export function listMcpServers(): string[] {
  return Object.keys(loadServerConfigs());
}
