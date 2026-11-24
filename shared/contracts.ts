import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";

const streamId = z.string().regex(/^[a-z0-9-]{1,40}$/);

/** "display" or an on-screen window id. Each event is [u8 type][payload]: 0 JPEG, 1 H.264 key, 2 H.264 delta. */
export const screenStream = defineSubscription({
  name: "screen.stream",
  input: z.object({
    target: z.string().regex(/^(display|\d+)$/),
    codec: z.enum(["h264", "jpeg"]),
    /** Client-chosen id; input and acks name the stream they belong to. */
    stream: streamId,
  }),
  event: z.instanceof(Uint8Array),
});

const windowInfo = z.object({
  id: z.number(),
  pid: z.number(),
  app: z.string(),
  title: z.string(),
  width: z.number(),
  height: z.number(),
  launched: z.boolean(),
});
export type WindowInfo = z.infer<typeof windowInfo>;

export const listWindows = defineRpc({
  name: "screen.windows",
  input: z.object({}),
  output: z.object({ canControl: z.boolean(), windows: z.array(windowInfo) }),
});

/** Input lines and frame acks for the helper, see server/helper-source.ts. */
export const sendInput = defineRpc({
  name: "screen.input",
  input: z.object({ stream: streamId, lines: z.array(z.string().regex(/^(kf|a \d+|[mduwk]( -?\d+(\.\d+)?)+)$/)).max(500) }),
  output: z.object({}),
});

const appStatus = z.object({
  running: z.boolean(),
  command: z.string(),
  directory: z.string(),
  /** Epoch ms of the last run, so viewers notice runs started elsewhere (e.g. by an agent). */
  startedAt: z.number(),
  exitCode: z.number().nullable(),
  log: z.array(z.string()),
});

export const runApp = defineRpc({
  name: "app.run",
  input: z.object({ directory: z.string(), command: z.string().min(1) }),
  output: appStatus,
});
export const stopApp = defineRpc({ name: "app.stop", input: z.object({}), output: appStatus });
export const getApp = defineRpc({ name: "app.status", input: z.object({}), output: appStatus });

/** A run command guessed from the workspace, e.g. a Godot project. */
export const suggestCommand = defineRpc({
  name: "app.suggest",
  input: z.object({ directory: z.string() }),
  output: z.object({ command: z.string() }),
});
