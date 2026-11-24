import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginSubscriptionContext } from "@getpaseo/plugin/server";
import type { listWindows, sendInput } from "../shared/contracts";
import { HELPER_SWIFT } from "./helper-source";
import { launchedPids } from "./app";

const run = promisify(execFile);
const STREAM_ARGS = ["30", "1280"]; // fps, max width

let helper: Promise<string> | null = null;

/** Compiles the Swift helper once per source version. */
export function helperPath(): Promise<string> {
  helper ??= (async () => {
    const dir = join(homedir(), "Library/Caches/paseo-screen");
    const bin = join(dir, `helper-${createHash("sha256").update(HELPER_SWIFT).digest("hex").slice(0, 12)}`);
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
  })().catch((error) => {
    helper = null;
    throw error;
  });
  return helper;
}

const MESSAGES: Record<string, string> = {
  "screen-recording-denied":
    "화면 기록 권한 필요: 시스템 설정 > 개인정보 보호 및 보안 > 화면 및 시스템 오디오 기록 > Paseo",
  "window-gone": "창이 닫혔음",
  "screen-locked": "노트북 화면이 잠겨 있음. 잠금 해제 후 다시 열기",
  "no-display": "켜진 화면이 없음. 노트북 덮개를 열어 두세요",
};
export function explain(stderr: string): string {
  const text = stderr.trim();
  return MESSAGES[text.split("\n")[0] ?? ""] ?? (text || "캡처가 멈춤");
}

export async function windows(_: RpcInput<typeof listWindows>): Promise<RpcOutput<typeof listWindows>> {
  const [bin, launched] = await Promise.all([helperPath(), launchedPids()]);
  const { stdout } = await run(bin, ["list"], { timeout: 10_000 }).catch((error: { stderr?: string }) => {
    throw new Error(explain(error.stderr ?? ""));
  });
  const parsed = JSON.parse(stdout) as { canControl: boolean; windows: Omit<RpcOutput<typeof listWindows>["windows"][number], "launched">[] };
  return {
    canControl: parsed.canControl,
    windows: parsed.windows.map((w) => ({ ...w, launched: launched.has(w.pid) })),
  };
}

const streams = new Map<string, ChildProcessWithoutNullStreams>();

export function input({ stream, lines }: RpcInput<typeof sendInput>): RpcOutput<typeof sendInput> {
  // A stream that already ended just drops its late acks and input.
  const child = streams.get(stream);
  if (child?.stdin.writable) child.stdin.write(`${lines.join("\n")}\n`);
  return {};
}

export async function stream(
  { target, codec, stream: id }: { target: string; codec: "h264" | "jpeg"; stream: string },
  { push, signal }: PluginSubscriptionContext<Uint8Array>,
): Promise<void> {
  const bin = await helperPath();
  if (signal.aborted) return;
  const child = spawn(bin, ["stream", target, ...STREAM_ARGS, codec]);
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
