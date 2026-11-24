import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ScreenPanel } from "./client/panel";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({ id: "screen", title: "화면", icon: "MonitorPlay", Component: ScreenPanel });
  client.addCommandCenterItem({
    id: "open-screen",
    title: "호스트 화면 열기",
    icon: "MonitorPlay",
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("screen");
    },
  });
  return () => {};
}
