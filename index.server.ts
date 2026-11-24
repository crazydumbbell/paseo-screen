import type { PluginServerContext } from "@getpaseo/plugin/server";
import { AGENT_PROMPT, AGENT_TOOLS } from "./server/agent-tools";
import { current, start, stop, suggest } from "./server/app";
import { input, stream, windows } from "./server/screen";
import { getApp, listWindows, runApp, screenStream, sendInput, stopApp, suggestCommand } from "./shared/contracts";

export default function contribute(server: PluginServerContext) {
  server.handle(screenStream, stream);
  server.handle(listWindows, windows);
  server.handle(sendInput, input);
  server.handle(runApp, start);
  server.handle(stopApp, stop);
  server.handle(getApp, current);
  server.handle(suggestCommand, suggest);
  // Every agent on this host can run, watch, and drive the app the user sees in the 화면 tab.
  server.before("agent.session_open", ({ request }) => ({
    ...request,
    tools: [...request.tools, ...AGENT_TOOLS],
    appendSystemPrompt: [...(request.appendSystemPrompt ?? []), AGENT_PROMPT],
  }));
  return () => {
    stop();
  };
}
