import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { defineAgentTool } from "@getpaseo/plugin/server";
import { z } from "zod";
import { MAC_KEYCODES } from "../shared/keys";
import { current, recentLog, start, stop } from "./app";
import { explain, helperPath, startHelper, windows, writeInput } from "./screen";

const exec = promisify(execFile);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const AGENT_PROMPT =
  "The Paseo host screen plugin is installed. To launch an app or game for the user, call screen_run instead of " +
  "starting it in a shell: the user watches it live in Paseo's 화면 tab. screen_status shows its output and exit " +
  "code, screen_capture saves a screenshot you can read, and screen_input clicks and presses keys using that " +
  "screenshot's pixel coordinates.";

const targetSchema = z
  .enum(["app", "display"])
  .default("app")
  .describe('"app" is the first window of the app started with screen_run; "display" is the whole screen.');

/** "app" → the launched app's window id, else the display. */
async function resolve(target: "app" | "display"): Promise<{ id: string; label: string }> {
  if (target === "app") {
    const w = (await windows({})).windows.find((x) => x.launched);
    if (w) return { id: String(w.id), label: `${w.app} · ${w.title}` };
  }
  return { id: "display", label: "whole screen" };
}

function describe(): string {
  const s = current();
  const state = s.running ? "running" : s.exitCode === null ? "not running" : `exited with code ${s.exitCode}`;
  const log = recentLog(30);
  return [`${state}${s.command ? `: ${s.command}` : ""}`, ...(log.length ? ["--- last output ---", ...log] : [])].join("\n");
}

async function size(path: string) {
  const { stdout } = await exec("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path]);
  return { width: Number(/pixelWidth: (\d+)/.exec(stdout)?.[1]), height: Number(/pixelHeight: (\d+)/.exec(stdout)?.[1]) };
}

async function shotMac(id: string, path: string) {
  await exec("screencapture", ["-x", "-o", "-t", "png", ...(id === "display" ? [] : ["-l", id]), path], { timeout: 10_000 });
  let { width, height } = await size(path);
  if (Math.max(width, height) > 1600) {
    await exec("sips", ["-Z", "1600", path], { timeout: 10_000 }); // shrink only: -Z also enlarges
    ({ width, height } = await size(path));
  }
  return { width, height };
}

/** The Windows helper captures, shrinks to 1600 px, saves the PNG, and prints "width height". */
async function shotWindows(id: string, path: string) {
  const { stdout } = await exec(await helperPath(), ["shot", id, path], { timeout: 15_000, windowsHide: true }).catch(
    (error: { stderr?: string }) => {
      throw new Error(explain(error.stderr ?? ""));
    },
  );
  const [width, height] = stdout.trim().split(" ").map(Number);
  return { width: width ?? 0, height: height ?? 0 };
}

// Size of the last screenshot per target, to turn its pixels into helper coordinates.
const shots = new Map<string, { width: number; height: number }>();

const run = defineAgentTool({
  name: "screen_run",
  title: "Run app on host screen",
  description:
    "Start an app or game on this machine so the user can watch and control it in Paseo's 화면 tab. " +
    "Stops the previously started one. Runs through a shell (zsh login shell on macOS, cmd on Windows) in the given directory (default: your cwd). " +
    'Example: { "command": "godot --path ." }',
  input: z.object({ command: z.string().min(1), directory: z.string().optional() }),
  async execute({ command, directory }, { agent }) {
    start({ command, directory: directory ?? agent.cwd });
    for (let i = 0; i < 20; i += 1) {
      await pause(500);
      const target = await resolve("app");
      if (target.id !== "display") return { text: `Started. Window: ${target.label}\n${describe()}` };
      if (!current().running) break;
    }
    return { text: `No window yet.\n${describe()}` };
  },
});

const stopTool = defineAgentTool({
  name: "screen_stop",
  title: "Stop host app",
  description: "Stop the app started with screen_run.",
  input: z.object({}),
  async execute() {
    stop();
    await pause(500);
    return { text: describe() };
  },
});

const status = defineAgentTool({
  name: "screen_status",
  title: "Host app status",
  description: "Whether the app started with screen_run is running, its exit code, and its last 30 lines of output.",
  input: z.object({}),
  execute: () => ({ text: describe() }),
});

const capture = defineAgentTool({
  name: "screen_capture",
  title: "Screenshot host screen",
  description:
    "Save a PNG screenshot of the app window (or the whole screen) and return its file path. Read the file to see it. " +
    "screen_input coordinates are pixels of the latest screenshot of the same target.",
  input: z.object({ target: targetSchema }),
  async execute({ target }) {
    const { id, label } = await resolve(target);
    const dir = join(tmpdir(), "paseo-screen");
    await mkdir(dir, { recursive: true });
    const path = join(dir, `shot-${Date.now()}.png`);
    try {
      const { width, height } = process.platform === "win32" ? await shotWindows(id, path) : await shotMac(id, path);
      shots.set(id, { width, height });
      return { text: `${path}\n${width}x${height}, ${label}` };
    } catch (error) {
      return { text: `Screenshot failed: ${String(error)}`, isError: true };
    }
  },
});

const action = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("click"),
    x: z.number(),
    y: z.number(),
    button: z.enum(["left", "right"]).default("left"),
  }),
  z.object({ type: z.literal("move"), x: z.number(), y: z.number() }),
  z.object({
    type: z.literal("key"),
    key: z.string().describe('KeyboardEvent.code, e.g. "Space", "KeyW", "ArrowUp", "Enter", "Escape", "Digit1"'),
    holdMs: z.number().min(0).max(10_000).default(60),
  }),
  z.object({ type: z.literal("wait"), ms: z.number().min(0).max(10_000) }),
]);

const input = defineAgentTool({
  name: "screen_input",
  title: "Click and type on host screen",
  description:
    "Send mouse clicks, moves, and key presses to the app window (or the whole screen), in order. " +
    "x and y are pixels in the latest screen_capture of the same target, so capture first. " +
    "The target app is brought to the front before the input.",
  input: z.object({ target: targetSchema, actions: z.array(action).min(1).max(100) }),
  async execute({ target, actions }) {
    const { id } = await resolve(target);
    const shot = shots.get(id);
    if (!shot) return { text: "Call screen_capture for this target first.", isError: true };
    const at = (x: number, y: number) => `${(x / shot.width).toFixed(4)} ${(y / shot.height).toFixed(4)}`;
    const lines: string[] = [];
    let total = 0;
    for (const a of actions) {
      if (a.type === "click") {
        const b = a.button === "right" ? 2 : 0;
        lines.push(`m ${at(a.x, a.y)}`, "s 30", `d ${at(a.x, a.y)} ${b}`, "s 50", `u ${at(a.x, a.y)} ${b}`);
        total += 80;
      } else if (a.type === "move") lines.push(`m ${at(a.x, a.y)}`);
      else if (a.type === "wait") {
        lines.push(`s ${a.ms}`);
        total += a.ms;
      } else {
        const code = MAC_KEYCODES[a.key];
        if (code === undefined) return { text: `Unknown key "${a.key}". Use KeyboardEvent.code names.`, isError: true };
        lines.push(`k ${code} 1`, `s ${a.holdMs}`, `k ${code} 0`);
        total += a.holdMs;
      }
    }
    const bin = await helperPath();
    const child = startHelper(bin, ["input", id]);
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.stdin.on("error", () => {});
    writeInput(child, lines, true);
    const code = await new Promise<number | null>((done) => {
      const timer = setTimeout(() => child.kill(), total + 10_000);
      child.on("exit", (c) => (clearTimeout(timer), done(c)));
      child.on("error", () => (clearTimeout(timer), done(-1)));
    });
    if (code !== 0) return { text: `Input failed: ${explain(stderr)}`, isError: true };
    return { text: `Sent ${actions.length} action(s). Capture again to see the result.` };
  },
});

export const AGENT_TOOLS = [run, stopTool, status, capture, input];
