import { type ChildProcess, execFile, spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { getApp, runApp, suggestCommand } from "../shared/contracts";

type Status = RpcOutput<typeof getApp>;
/** [pid, parent pid] pairs. */
export type ParentPairs = [number, number][];
const WINDOWS = process.platform === "win32";

let child: ChildProcess | null = null;
let command = "";
let directory = "";
let exitCode: number | null = null;
let startedAt = 0;
let log: string[] = [];

function status(): Status {
  return { running: child !== null, command, directory, startedAt, exitCode, log: log.slice(-20) };
}

function collect(chunk: Buffer) {
  log.push(...chunk.toString().split("\n").filter(Boolean));
  if (log.length > 200) log = log.slice(-200);
}

export function stop(): Status {
  const pid = child?.pid;
  if (!pid) return status();
  if (WINDOWS) {
    // taskkill /T takes the shell and everything it started.
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
  } else {
    // Detached, so the pid is also the process group: the shell and the game it started.
    try {
      process.kill(-pid, "SIGTERM");
    } catch {}
  }
  return status();
}

export function start(input: RpcInput<typeof runApp>): Status {
  if (!statSync(input.directory, { throwIfNoEntry: false })?.isDirectory()) throw new Error("폴더가 없음");
  stop();
  command = input.command;
  directory = input.directory;
  startedAt = Date.now();
  exitCode = null;
  log = [];
  // macOS: a login shell picks up the user's PATH (Homebrew godot, node, ...). Windows: cmd.exe, with its
  // own console hidden; the app's windows still show.
  const proc = WINDOWS
    ? spawn(input.command, { cwd: input.directory, shell: true, windowsHide: true })
    : spawn("/bin/zsh", ["-lc", input.command], { cwd: input.directory, detached: true });
  child = proc;
  proc.stdout?.on("data", collect);
  proc.stderr?.on("data", collect);
  proc.on("exit", (code) => {
    if (child !== proc) return;
    child = null;
    exitCode = code;
  });
  return status();
}

export const current = (): Status => status();
export const recentLog = (lines: number): string[] => log.slice(-lines);

/** Pids of the launched app and everything it started. Windows passes the helper's process table. */
export async function launchedPids(pairs?: ParentPairs): Promise<Set<number>> {
  const root = child?.pid;
  const found = new Set<number>();
  if (!root) return found;
  const parentOf =
    pairs ??
    (await promisify(execFile)("ps", ["-axo", "pid=,ppid="])).stdout
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number) as [number, number]);
  found.add(root);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [pid, ppid] of parentOf)
      if (found.has(ppid) && !found.has(pid)) {
        found.add(pid);
        grew = true;
      }
  }
  return found;
}

export function suggest({ directory }: RpcInput<typeof suggestCommand>): RpcOutput<typeof suggestCommand> {
  if (existsSync(join(directory, "project.godot"))) return { command: "godot --path ." };
  try {
    for (const entry of readdirSync(directory, { withFileTypes: true }))
      if (entry.isDirectory() && existsSync(join(directory, entry.name, "project.godot")))
        return { command: `godot --path ${entry.name}` };
  } catch {}
  return { command: "" };
}
