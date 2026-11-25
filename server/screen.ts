import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginSubscriptionContext } from "@getpaseo/plugin/server";
import type { listWindows, runApp, sendInput } from "../shared/contracts";
import { MAC_TO_VK } from "../shared/keys";
import { HELPER_SWIFT } from "./helper-source";
import { HELPER_CSHARP } from "./helper-windows";
import { current, launchedPids, type ParentPairs, start } from "./app";

const run = promisify(execFile);
const STREAM_ARGS = ["30", "1280"]; // fps, max width

const WINDOWS = process.platform === "win32";
export const SUPPORTED = process.platform === "darwin" || WINDOWS;

let helper: Promise<string> | null = null;

/** Compiles the platform helper once per source version: Swift on macOS, C# on Windows. */
export function helperPath(): Promise<string> {
  if (!SUPPORTED) return Promise.reject(new Error("화면 전송은 macOS와 Windows 호스트만 지원"));
  helper ??= (WINDOWS ? buildWindows() : buildMac()).catch((error) => {
    helper = null;
    throw error;
  });
  return helper;
}

const versioned = (source: string) => `helper-${createHash("sha256").update(source).digest("hex").slice(0, 12)}`;

async function buildMac(): Promise<string> {
  const dir = join(homedir(), "Library/Caches/paseo-screen");
  const bin = join(dir, versioned(HELPER_SWIFT));
  if (existsSync(bin)) return bin;
  await mkdir(dir, { recursive: true });
  const source = join(dir, "main.swift");
  await writeFile(source, HELPER_SWIFT);
  try {
    await run("xcrun", ["swiftc", "-O", "-o", `${bin}.tmp`, source], { timeout: 180_000 });
  } catch (error) {
    throw new Error(`Swift 컴파일 실패. xcode-select --install 후 다시 시도\n${String(error)}`);
  }
  // macOS ties Screen Recording and Accessibility approval to the signer. An ad-hoc build is a new app
  // after every update and asks again; a local Apple Development identity keeps one approval.
  await run("codesign", ["-f", "-s", "Apple Development", "-i", "com.paseo-screen.helper", `${bin}.tmp`], { timeout: 20_000 }).catch(() => {});
  await rename(`${bin}.tmp`, bin);
  return bin;
}

async function buildWindows(): Promise<string> {
  const dir = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "paseo-screen");
  const bin = join(dir, `${versioned(HELPER_CSHARP)}.exe`);
  if (existsSync(bin)) return bin;
  await mkdir(dir, { recursive: true });
  const source = join(dir, "helper.cs");
  await writeFile(source, HELPER_CSHARP);
  // csc.exe ships with .NET Framework 4 on every Windows 10 and 11 install.
  const framework = join(process.env.WINDIR ?? "C:\\Windows", "Microsoft.NET");
  const csc = [join(framework, "Framework64", "v4.0.30319", "csc.exe"), join(framework, "Framework", "v4.0.30319", "csc.exe")].find(existsSync);
  if (!csc) throw new Error(".NET Framework 4의 csc.exe를 찾지 못함");
  const tmp = `${bin}.tmp.exe`;
  try {
    await run(csc, ["/nologo", "/optimize+", "/unsafe", "/target:exe", "/r:System.Drawing.dll", `/out:${tmp}`, source], {
      timeout: 180_000,
      windowsHide: true,
    });
  } catch (error) {
    throw new Error(`C# 컴파일 실패\n${String((error as { stdout?: string }).stdout ?? error)}`);
  }
  await rename(tmp, bin);
  return bin;
}

/** The client and agent tools speak macOS keycodes; the Windows helper wants virtual-key codes. */
function forHelper(lines: string[]): string[] {
  if (!WINDOWS) return lines;
  return lines.flatMap((line) => {
    const m = /^k (\d+) ([01])$/.exec(line);
    if (!m) return [line];
    const vk = MAC_TO_VK.get(Number(m[1]));
    return vk === undefined ? [] : [`k ${vk} ${m[2]}`];
  });
}

/** Writes input lines to a helper's stdin. */
export function writeInput(child: ChildProcessWithoutNullStreams, lines: string[], end = false) {
  const text = `${forHelper(lines).join("\n")}\n`;
  if (end) child.stdin.end(text);
  else if (child.stdin.writable) child.stdin.write(text);
}

/** Starts the helper without flashing a console window on Windows. */
export const startHelper = (bin: string, args: string[]) => spawn(bin, args, { windowsHide: true });

const MESSAGES: Record<string, string> = {
  "screen-recording-denied":
    "화면 기록 권한 필요: 시스템 설정 > 개인정보 보호 및 보안 > 화면 및 시스템 오디오 기록 > Paseo",
  "window-gone": "창이 닫혔음",
  "screen-locked": "노트북 화면이 잠겨 있음. 잠금 해제 후 다시 열기",
  "no-display": "켜진 화면이 없음. 노트북 덮개를 열어 두세요",
  "window-minimized": "창이 최소화돼 있음",
};
export function explain(stderr: string): string {
  const text = stderr.trim();
  return MESSAGES[text.split("\n")[0] ?? ""] ?? (text || "캡처가 멈춤");
}

export async function windows(_: RpcInput<typeof listWindows>): Promise<RpcOutput<typeof listWindows>> {
  const bin = await helperPath();
  const { stdout } = await run(bin, ["list"], { timeout: 10_000, windowsHide: true }).catch((error: { stderr?: string }) => {
    throw new Error(explain(error.stderr ?? ""));
  });
  const parsed = JSON.parse(stdout) as {
    canControl: boolean;
    windows: Omit<RpcOutput<typeof listWindows>["windows"][number], "launched">[];
    /** Windows only: [pid, parent pid] for every process, since there is no ps. */
    parents?: ParentPairs;
  };
  const launched = await launchedPids(parsed.parents);
  let list = parsed.windows.map((w) => ({ ...w, launched: launched.has(w.pid) }));
  // Some launchers hand off and exit at once (Windows 11 Notepad, Store apps, `open -a`), so the app's
  // window has no parent link to what we ran. Then take a window that appeared after the launch.
  if (baseline && !list.some((w) => w.launched) && !current().running && Date.now() - baseline.at < 20_000) {
    const before = baseline.ids;
    list = list.map((w) => ({ ...w, launched: !before.has(w.id) }));
  }
  return { canControl: parsed.canControl, windows: list };
}

let baseline: { ids: Set<number>; at: number } | null = null;

/** Starts the app after noting which windows already exist. */
export async function launch(input: RpcInput<typeof runApp>) {
  baseline = null;
  const ids = await windows({})
    .then((r) => new Set(r.windows.map((w) => w.id)))
    .catch(() => null);
  const status = start(input);
  baseline = ids && { ids, at: Date.now() };
  return status;
}

const streams = new Map<string, ChildProcessWithoutNullStreams>();

export function input({ stream, lines }: RpcInput<typeof sendInput>): RpcOutput<typeof sendInput> {
  // A stream that already ended just drops its late acks and input.
  const child = streams.get(stream);
  if (child) writeInput(child, lines);
  return {};
}

export async function stream(
  { target, codec, stream: id }: { target: string; codec: "h264" | "jpeg"; stream: string },
  { push, signal }: PluginSubscriptionContext<Uint8Array>,
): Promise<void> {
  const bin = await helperPath();
  if (signal.aborted) return;
  const child = startHelper(bin, ["stream", target, ...STREAM_ARGS, codec]);
  streams.set(id, child);
  child.stdin.on("error", () => {}); // EPIPE when the helper exits mid-write
  const forget = () => {
    if (streams.get(id) === child) streams.delete(id);
  };
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

  // The helper drops frames itself until the client acknowledges; every frame it emits must arrive.
  let buffer: Buffer = Buffer.alloc(0);
  child.stdout.on("data", (chunk: Buffer) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    while (buffer.length >= 4) {
      const end = 4 + buffer.readUInt32BE(0);
      if (buffer.length < end) break;
      void push(new Uint8Array(buffer.subarray(4, end))).catch(() => {});
      buffer = buffer.subarray(end);
    }
  });

  await new Promise<void>((resolve, reject) => {
    signal.addEventListener("abort", () => child.kill(), { once: true });
    child.on("error", (error) => {
      forget();
      reject(error);
    });
    child.on("exit", () => {
      forget();
      if (signal.aborted) resolve();
      else reject(new Error(explain(stderr)));
    });
  });
}
