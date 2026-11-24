import { Platform } from "react-native";
import { MAC_KEYCODES } from "../shared/keys";

// This plugin typechecks without the DOM library. Declare only what this module uses.
type Dom = any; // eslint-disable-line @typescript-eslint/no-explicit-any
declare const Blob: Dom;
declare const VideoDecoder: Dom;
declare const EncodedVideoChunk: Dom;
declare const document: Dom;
declare function createImageBitmap(blob: unknown): Promise<Dom>;

export interface Surface {
  /** A new stream starts: frames, acks, and input now belong to `id`. */
  start(id: string): void;
  /** One stream event: [u8 type][payload], 0 JPEG, 1 H.264 key, 2 H.264 delta. */
  draw(frame: Uint8Array): void;
  destroy(): void;
}

export const h264Available = (): boolean => Platform.OS === "web" && typeof VideoDecoder !== "undefined";

/**
 * A canvas inside `host` that shows frames and turns mouse and keys into helper input lines.
 * The canvas keeps the video's own resolution; CSS object-fit scales it on the GPU.
 */
export function mountSurface(
  host: unknown,
  send: (stream: string, lines: string[]) => void,
  onDecodeFailed: () => void,
): Surface | null {
  if (Platform.OS !== "web" || !host) return null;
  const canvas = document.createElement("canvas");
  canvas.tabIndex = 0;
  Object.assign(canvas.style, {
    width: "100%",
    height: "100%",
    display: "block",
    objectFit: "contain",
    outline: "none",
    touchAction: "none",
  });
  (host as Dom).appendChild(canvas);
  const ctx = canvas.getContext("2d", { alpha: false });

  let stream = "";
  let received = 0;
  let current = 0; // bumps on every stream start so late frames of the old one are dropped
  let videoW = 0;
  let videoH = 0;
  const show = (picture: Dom, generation: number) => {
    if (generation !== current) return picture.close();
    const w = picture.displayWidth ?? picture.width;
    const h = picture.displayHeight ?? picture.height;
    if (w !== videoW || h !== videoH) {
      canvas.width = videoW = w;
      canvas.height = videoH = h;
    }
    ctx.drawImage(picture, 0, 0);
    picture.close();
  };

  // ---- Decoding ----
  let jpegBusy = false;
  let jpegQueued: Uint8Array | null = null;
  const drawJpeg = (jpeg: Uint8Array) => {
    if (jpegBusy) {
      jpegQueued = jpeg;
      return;
    }
    jpegBusy = true;
    const generation = current;
    createImageBitmap(new Blob([jpeg], { type: "image/jpeg" }))
      .then((bitmap) => show(bitmap, generation))
      .catch(() => {})
      .finally(() => {
        jpegBusy = false;
        const next = jpegQueued;
        jpegQueued = null;
        if (next && generation === current) drawJpeg(next);
      });
  };

  let decoder: Dom = null;
  let failures = 0;
  let timestamp = 0;
  const closeDecoder = () => {
    if (decoder && decoder.state !== "closed") decoder.close();
    decoder = null;
  };
  const decodeFailed = () => {
    closeDecoder();
    // Ask for a fresh keyframe twice before giving up on H.264 for this tab.
    if (++failures >= 3) onDecodeFailed();
    else enqueue("kf");
  };
  const drawH264 = (key: boolean, data: Uint8Array) => {
    if (!decoder) {
      if (!key) return;
      const generation = current;
      decoder = new VideoDecoder({ output: (frame: Dom) => show(frame, generation), error: decodeFailed });
      // No description: the stream is Annex B with SPS/PPS in every keyframe.
      decoder.configure({ codec: "avc1.42e033", optimizeForLatency: true, hardwareAcceleration: "prefer-hardware" });
    }
    if (decoder.state !== "configured") return;
    decoder.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: (timestamp += 33_333), data }));
    if (key) failures = 0;
  };

  // ---- Input and acks ----
  // Clicks, keys, and acks go out right away; mouse moves coalesce to one per ~16 ms.
  let lines: string[] = [];
  let move: string | null = null;
  let ackDue = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timerDelay = Infinity;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    timerDelay = Infinity;
    if (move) lines.push(move);
    if (ackDue) lines.push(`a ${received}`);
    move = null;
    ackDue = false;
    if (lines.length && stream) send(stream, lines);
    lines = [];
  };
  const schedule = (delay: number) => {
    if (timer && timerDelay <= delay) return;
    if (timer) clearTimeout(timer);
    timerDelay = delay;
    timer = setTimeout(flush, delay);
  };
  const enqueue = (line: string, isMove = false) => {
    if (isMove) {
      move = line;
      return schedule(16);
    }
    if (move) lines.push(move);
    move = null;
    lines.push(line);
    schedule(0);
  };

  const at = (e: Dom): string | null => {
    const r = canvas.getBoundingClientRect();
    if (!videoW || !r.width || !r.height) return null;
    const s = Math.min(r.width / videoW, r.height / videoH);
    const x = (e.clientX - r.left - (r.width - videoW * s) / 2) / (videoW * s);
    const y = (e.clientY - r.top - (r.height - videoH * s) / 2) / (videoH * s);
    return `${x.toFixed(4)} ${y.toFixed(4)}`;
  };
  const button = (e: Dom) => (e.button === 2 ? 2 : 0);
  const held = new Set<number>();
  const releaseKeys = () => {
    for (const code of held) enqueue(`k ${code} 0`);
    held.clear();
  };
  const key = (down: boolean) => (e: Dom) => {
    const code = MAC_KEYCODES[e.code];
    if (code === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    if (down) held.add(code);
    else held.delete(code);
    enqueue(`k ${code} ${down ? 1 : 0}`);
  };
  const pointer = (prefix: "m" | "d" | "u") => (e: Dom) => {
    const p = at(e);
    if (!p) return;
    if (prefix === "m") return enqueue(`m ${p}`, true);
    if (prefix === "d") {
      e.preventDefault();
      canvas.focus({ preventScroll: true });
      canvas.setPointerCapture(e.pointerId);
    }
    enqueue(`${prefix} ${p} ${button(e)}`);
  };
  const listeners: [string, (e: Dom) => void][] = [
    ["pointermove", pointer("m")],
    ["pointerdown", pointer("d")],
    ["pointerup", pointer("u")],
    ["contextmenu", (e) => e.preventDefault()],
    ["wheel", (e) => {
      e.preventDefault();
      enqueue(`w ${Math.round(-e.deltaX)} ${Math.round(-e.deltaY)}`);
    }],
    ["keydown", key(true)],
    ["keyup", key(false)],
    ["blur", releaseKeys],
  ];
  for (const [type, fn] of listeners) canvas.addEventListener(type, fn, { passive: false });

  return {
    start(id) {
      releaseKeys();
      flush();
      closeDecoder();
      current += 1;
      jpegQueued = null;
      stream = id;
      received = 0;
      failures = 0;
    },
    draw(frame) {
      if (frame.byteLength < 2) return;
      received += 1;
      ackDue = true;
      schedule(0);
      const payload = frame.subarray(1);
      if (frame[0] === 0) return drawJpeg(payload);
      try {
        drawH264(frame[0] === 1, payload);
      } catch {
        decodeFailed();
      }
    },
    destroy() {
      releaseKeys();
      flush();
      current += 1;
      closeDecoder();
      canvas.remove();
    },
  };
}
