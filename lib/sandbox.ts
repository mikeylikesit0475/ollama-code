// ─── Sandboxing (bwrap) ────────────────────────────────────────────────────
// Optional confinement for execute_bash. When enabled, shell commands run
// inside a bubblewrap (bwrap) sandbox that:
//   - blocks all network access (--unshare-net)
//   - confines the filesystem to the workspace (bound read-write) plus a
//     read-only view of the system dirs (/usr, /bin, /lib, /etc) and $HOME
//   - isolates the process in its own PID/UTS/IPC/user namespaces and dies
//     with the parent (--die-with-parent) so a runaway child can't leak
//
// This is the "brakes" for the excessive-execute_bash failure mode: even if a
// model goes haywire, it cannot touch anything outside the workspace or reach
// the network. It is opt-in via the /sandbox toggle (persisted in config.json)
// and defaults to OFF so existing workflows are unaffected.

import { execSync } from "child_process";
import fs from "fs";
import path from "path";

let sandboxEnabled = false;

export function isSandboxEnabled(): boolean {
  return sandboxEnabled;
}

export function setSandboxEnabled(enabled: boolean) {
  sandboxEnabled = enabled;
}

// Detect whether bubblewrap is installed on the system.
export function isBwrapAvailable(): boolean {
  try {
    execSync("which bwrap", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Build the bwrap argv that confines `command` to the workspace. Returns null
// when sandboxing is disabled or bwrap is unavailable (caller falls back to a
// plain shell spawn). The workspace root is bound read-write so the agent can
// still create/edit files; $HOME is bound read-only for config/caches.
export function wrapCommand(command: string, cwd: string): { file: string; args: string[] } | null {
  if (!sandboxEnabled) return null;
  if (!isBwrapAvailable()) return null;

  const workspaceRoot = path.resolve(process.cwd());
  const homeDir = process.env.HOME || "";

  const args = [
    "--unshare-all",
    "--die-with-parent",
    "--unshare-net",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/bin", "/bin",
    "--ro-bind", "/lib", "/lib",
    "--ro-bind", "/lib64", "/lib64",
    "--ro-bind", "/etc", "/etc",
    "--bind", workspaceRoot, workspaceRoot,
  ];

  if (homeDir && homeDir !== workspaceRoot && fs.existsSync(homeDir)) {
    args.push("--ro-bind", homeDir, homeDir);
  }

  args.push("/bin/sh", "-c", command);

  return { file: "bwrap", args };
}
