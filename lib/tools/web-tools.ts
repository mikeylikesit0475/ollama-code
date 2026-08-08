// ─── web_fetch, todo_write ───────────────────────────────────────────────────

import { FunctionTool } from "@google/adk";
import { z } from "zod";
import fs from "fs";
import net from "net";
import path from "path";
import { lookup as dnsLookup } from "dns/promises";
import { withRetry } from "../retry.ts";

// ─── web_fetch SSRF guards ───────────────────────────────────────────────────
// web_fetch's URL is model-controlled. Without checks a small local model can
// be tricked (or just hallucinate) into hitting internal services or cloud
// metadata endpoints (e.g. 169.254.169.254) and leaking the response back
// into its own context. We: restrict to http/https, resolve the hostname and
// reject private/loopback/link-local/reserved targets, and re-validate on
// every redirect hop (a public host can otherwise 302 to an internal one).

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isPrivateIPv4(ip: string): boolean {
  const int = ipv4ToInt(ip);
  const inRange = (base: string, bits: number) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (int & mask) === (ipv4ToInt(base) & mask);
  };
  return (
    inRange("0.0.0.0", 8) ||      // "this network"
    inRange("10.0.0.0", 8) ||     // private
    inRange("100.64.0.0", 10) ||  // shared/CGNAT
    inRange("127.0.0.0", 8) ||    // loopback
    inRange("169.254.0.0", 16) || // link-local — covers 169.254.169.254 cloud metadata
    inRange("172.16.0.0", 12) ||  // private
    inRange("192.0.0.0", 24) ||   // IETF protocol assignments
    inRange("192.168.0.0", 16) || // private
    inRange("198.18.0.0", 15) ||  // benchmarking
    inRange("224.0.0.0", 4) ||    // multicast
    inRange("240.0.0.0", 4)       // reserved
  );
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true; // loopback / unspecified
  if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
  if (/^f[cd]/.test(lower)) return true; // fc00::/7 unique local — covers AWS's fd00:ec2::254
  if (lower.startsWith("ff")) return true; // multicast
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPrivateIPv4(mapped[1]); // IPv4-mapped IPv6
  return false;
}

function isBlockedFetchAddress(address: string, family: number): boolean {
  return family === 6 ? isPrivateIPv6(address) : isPrivateIPv4(address);
}

async function assertSafeFetchTarget(urlStr: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error(`Invalid URL: "${urlStr}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Blocked: only http/https URLs are allowed (got "${parsed.protocol}")`);
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  const literalFamily = net.isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await dnsLookup(hostname, { all: true });

  if (addresses.length === 0) {
    throw new Error(`Could not resolve host: ${hostname}`);
  }
  for (const { address, family } of addresses) {
    if (isBlockedFetchAddress(address, family)) {
      throw new Error(`Blocked: "${hostname}" resolves to a private/internal address (${address}). Refusing to fetch.`);
    }
  }
  return parsed;
}

async function safeFetch(urlStr: string, maxRedirects = 5): Promise<Response> {
  let currentUrl = urlStr;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const validated = await assertSafeFetchTarget(currentUrl);
    const res = await withRetry(() => fetch(validated.toString(), { redirect: "manual" }), {
      maxRetries: 2,
      shouldRetry: (err: any) => {
        const status = err?.status ?? err?.code;
        if (typeof status === "number") return status >= 500;
        return err?.name === "AbortError" || err?.code === "ETIMEDOUT" || err?.code === "ECONNRESET";
      },
    });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      currentUrl = new URL(location, validated).toString();
      continue;
    }
    return res;
  }
  throw new Error("Too many redirects.");
}

// Strips script/style content and remaining markup so raw HTML isn't dumped
// straight into a small local model's context, where it's both token-wasteful
// and a prompt-injection vector (e.g. hidden "ignore previous instructions"
// text in a comment or attribute). Non-HTML responses (JSON, plain text) pass
// through untouched.
function stripHtmlForIngestion(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Tool 5.9: web_fetch (non-interactive)
export const webFetch = new FunctionTool({
  name: "web_fetch",
  description: "Fetch the HTML or raw text content of a public URL.",
  parameters: z.object({
    url: z.string().describe("The HTTP/HTTPS URL to fetch.")
  }),
  execute: async ({ url }) => {
    try {
      const res = await safeFetch(url);
      if (!res.ok) {
        return { status: "error", message: `Request failed with status ${res.status} ${res.statusText}` };
      }
      const contentType = res.headers.get("content-type") || "";
      const text = await res.text();
      const content = contentType.toLowerCase().includes("html") ? stripHtmlForIngestion(text) : text;
      return { status: "success", content: content.substring(0, 15000) };
    } catch (err: any) {
      return { status: "error", message: err.message };
    }
  }
});

// Tool 5.95: todo_write (non-interactive)
export const todoWrite = new FunctionTool({
  name: "todo_write",
  description: "Create or update a structured checklist in TODO.md to plan and track progress on long, multi-step tasks.",
  parameters: z.object({
    todos: z.array(z.string()).describe("List of all TODO items."),
    completed: z.array(z.string()).optional().describe("List of completed TODO items.")
  }),
  execute: async ({ todos, completed = [] }) => {
    try {
      const todoPath = path.resolve("TODO.md");
      let fileContent = "# Task Checklist\n\n";
      for (const todo of todos) {
        const isDone = completed.includes(todo);
        fileContent += `- [${isDone ? "x" : " "}] ${todo}\n`;
      }
      fs.writeFileSync(todoPath, fileContent, "utf-8");
      return { status: "success", message: "Successfully updated TODO.md" };
    } catch (err: any) {
      return { status: "error", message: err.message };
    }
  }
});
