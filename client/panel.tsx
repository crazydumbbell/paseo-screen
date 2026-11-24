import {
  type PluginWorkspacePanelProps,
  useRpc,
  useSubscription,
  useTabState,
  useWorkspace,
} from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { z } from "zod";
import {
  getApp,
  listWindows,
  runApp,
  screenStream,
  sendInput,
  stopApp,
  suggestCommand,
  type WindowInfo,
} from "../shared/contracts";
import { h264Available, mountSurface, type Surface } from "./web";

const tabSchema = z.object({ command: z.string(), target: z.string() });

export function ScreenPanel({ theme, layout, workspaceId, tab }: PluginWorkspacePanelProps) {
  const styles = useStyles(theme, layout.compact);
  const directory = useWorkspace(workspaceId, (w) => w.directory);
  const [saved, save] = useTabState(tab, tabSchema, { command: "", target: "display" });
  if (Platform.OS !== "web") return <WebOnly styles={styles} />;
  return <Viewer styles={styles} directory={directory} saved={saved} save={save} />;
}

function WebOnly({ styles }: { styles: Styles }) {
  return (
    <View style={styles.screen}>
      <Text style={styles.muted}>데스크톱 앱에서 열어 주세요</Text>
    </View>
  );
}

type Saved = z.infer<typeof tabSchema>;
function Viewer({
  styles,
  directory,
  saved,
  save,
}: {
  styles: Styles;
  directory: string | null;
  saved: Saved;
  save: (next: Saved) => void;
}) {
  const [command, setCommand] = useState(saved.command);
  const target = saved.target;
  const setTarget = (next: string) => save({ command, target: next });

  const status = useRpc(getApp);
  const app = useQuery({
    queryKey: ["app"],
    queryFn: () => status({}),
    refetchInterval: (q) => (q.state.data?.running ? 1500 : 5000),
  });

  const suggest = useRpc(suggestCommand);
  useEffect(() => {
    if (saved.command || !directory) return;
    void suggest({ directory })
      .then((r) => r.command && setCommand((c) => c || r.command))
      .catch(() => {});
  }, [directory, saved.command, suggest]);

  // Listing windows spawns a helper on the host, so poll fast only while waiting for a launched app.
  const following = useRef(false);
  const list = useRpc(listWindows);
  const windows = useQuery({
    queryKey: ["windows"],
    queryFn: () => list({}),
    refetchInterval: () => (following.current ? 1000 : 15_000),
  });
  const run = useRpc(runApp);
  const stop = useRpc(stopApp);
  const [error, setError] = useState<string | null>(null);

  // A run started anywhere (this tab, another workspace, an agent tool) makes the tab follow its window.
  const startedAt = app.data?.startedAt ?? 0;
  const seenStart = useRef<number | null>(null);
  useEffect(() => {
    if (!app.data) return;
    // A tab opened while the app already runs (say, started from another workspace) shows it too,
    // unless this tab was set to a specific window.
    const fresh = seenStart.current === null ? target === "display" : startedAt !== seenStart.current;
    if (fresh && app.data.running) {
      following.current = true;
      void windows.refetch();
    }
    seenStart.current = startedAt;
  }, [startedAt, !!app.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // After 실행, follow the first window the launched app opens.
  const launched = windows.data?.windows.find((w) => w.launched)?.id;
  useEffect(() => {
    if (following.current && launched) {
      following.current = false;
      setTarget(String(launched));
    }
  }, [launched]); // eslint-disable-line react-hooks/exhaustive-deps
  // A closed window falls back to the whole screen.
  const targetGone = target !== "display" && !!windows.data && !windows.data.windows.some((w) => String(w.id) === target);
  useEffect(() => {
    if (targetGone) setTarget("display");
  }, [targetGone]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = async () => {
    setError(null);
    try {
      if (app.data?.running) await stop({});
      else if (directory && command.trim()) {
        save({ command, target });
        following.current = true;
        await run({ directory, command: command.trim() });
        void windows.refetch();
      }
      await app.refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const input = useRpc(sendInput);
  const inputRef = useRef(input);
  inputRef.current = input;
  const host = useRef<View>(null);
  const surface = useRef<Surface | null>(null);
  useEffect(() => {
    const s = mountSurface(
      host.current,
      (stream, lines) => void inputRef.current({ stream, lines }).catch(() => {}),
      () => setCodec("jpeg"),
    );
    surface.current = s;
    return () => s?.destroy();
  }, []);

  const frames = useRef(0);
  const bytes = useRef(0);
  const [rate, setRate] = useState({ fps: 0, kbps: 0 });
  useEffect(() => {
    const timer = setInterval(() => {
      setRate({ fps: frames.current, kbps: Math.round(bytes.current / 1024) });
      frames.current = 0;
      bytes.current = 0;
    }, 1000);
    return () => clearInterval(timer);
  }, []);
  // A failed stream (locked screen, closed window) retries on its own with a new stream id.
  const [attempt, setAttempt] = useState(0);
  const [codec, setCodec] = useState<"h264" | "jpeg">(h264Available() ? "h264" : "jpeg");
  const streamId = useMemo(
    () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    [target, codec, attempt], // eslint-disable-line react-hooks/exhaustive-deps
  );
  useEffect(() => surface.current?.start(streamId), [streamId]); // before the subscription opens
  const stream = useSubscription(screenStream, { target, codec, stream: streamId }, (frame) => {
    frames.current += 1;
    bytes.current += frame.byteLength;
    surface.current?.draw(frame);
  });
  useEffect(() => {
    if (stream.status !== "error" && stream.status !== "closed") return;
    void windows.refetch();
    const timer = setTimeout(() => setAttempt((n) => n + 1), 2000);
    return () => clearTimeout(timer);
  }, [stream.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const running = app.data?.running ?? false;
  const line = statusLine({
    error: error ?? (stream.status === "error" ? stream.error.message : null) ?? windows.error?.message ?? null,
    rate,
    codec,
    live: stream.status === "live",
    canControl: windows.data?.canControl ?? true,
    app: app.data,
  });

  return (
    <View style={styles.screen}>
      <View style={styles.bar}>
        <TextInput
          style={styles.input}
          value={command}
          onChangeText={setCommand}
          onSubmitEditing={toggle}
          placeholder="실행 명령"
          placeholderTextColor={styles.muted.color}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Pressable accessibilityRole="button" onPress={toggle} style={running ? styles.stop : styles.run}>
          <Text style={running ? styles.stopText : styles.runText}>{running ? "중지" : "실행"}</Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow} contentContainerStyle={styles.chips}>
        <Chip label="전체 화면" active={target === "display"} onPress={() => setTarget("display")} styles={styles} />
        {(windows.data?.windows ?? []).map((w) => (
          <Chip key={w.id} label={label(w)} active={target === String(w.id)} onPress={() => setTarget(String(w.id))} styles={styles} />
        ))}
      </ScrollView>
      <View ref={host} style={styles.view} />
      <Text style={styles.muted} numberOfLines={1}>
        {line}
      </Text>
    </View>
  );
}

function label(w: WindowInfo) {
  const title = w.title && w.title !== w.app ? ` · ${w.title}` : "";
  return `${w.launched ? "▶ " : ""}${w.app}${title}`.slice(0, 48);
}

function statusLine(s: {
  error: string | null;
  rate: { fps: number; kbps: number };
  codec: string;
  live: boolean;
  canControl: boolean;
  app: { running: boolean; exitCode: number | null; log: string[] } | undefined;
}) {
  if (s.error) return s.error;
  const parts = [s.live ? `${s.rate.fps} fps · ${s.rate.kbps} KB/s · ${s.codec === "h264" ? "H.264" : "JPEG"}` : "연결 중"];
  if (!s.canControl) parts.push("입력 권한 없음: 손쉬운 사용 > Paseo");
  if (s.app?.running) parts.push("실행 중");
  else if (s.app?.exitCode != null) parts.push(`종료 코드 ${s.app.exitCode}`);
  const last = s.app?.log.at(-1);
  if (last) parts.push(last);
  return parts.join(" · ");
}

function Chip({ label, active, onPress, styles }: { label: string; active: boolean; onPress: () => void; styles: Styles }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={active ? styles.chipActive : styles.chip}>
      <Text style={active ? styles.chipActiveText : styles.chipText} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

type Styles = ReturnType<typeof useStyles>;
function useStyles(theme: PluginWorkspacePanelProps["theme"], compact: boolean) {
  return useMemo(() => {
    const c = theme.colors;
    const button = { paddingHorizontal: 14, justifyContent: "center" as const, borderRadius: 8 };
    const chip = { paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999, borderWidth: 1 };
    return StyleSheet.create({
      screen: { flex: 1, padding: compact ? 8 : 12, gap: 8, backgroundColor: c.surface0 },
      bar: { flexDirection: "row", gap: 8 },
      input: {
        flex: 1,
        paddingVertical: 6,
        paddingHorizontal: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: c.border,
        color: c.foreground,
        backgroundColor: c.surface1,
        fontFamily: "monospace",
      },
      run: { ...button, backgroundColor: c.accent },
      runText: { color: c.accentForeground },
      stop: { ...button, backgroundColor: c.statusDanger },
      stopText: { color: c.accentForeground },
      chipRow: { flexGrow: 0, flexShrink: 0 },
      chips: { gap: 6, alignItems: "center" },
      chip: { ...chip, borderColor: c.border },
      chipActive: { ...chip, borderColor: c.accent, backgroundColor: c.accent },
      chipText: { color: c.foregroundMuted, fontSize: 12 },
      chipActiveText: { color: c.accentForeground, fontSize: 12 },
      view: { flex: 1, minHeight: 0, borderRadius: 8, overflow: "hidden", backgroundColor: c.surface1 },
      muted: { color: c.foregroundMuted, fontSize: 12 },
    });
  }, [theme, compact]);
}
