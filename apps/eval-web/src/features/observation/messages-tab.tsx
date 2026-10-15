import { CloudOsChatMessages, CloudOsRoot } from "@springbrand/message-panel/cloud-os";
import type { UIMessage } from "ai";
import { useDarkMode } from "@/lib/use-dark";

/**
 * The same renderer SP's Chat page uses, fed a finished or running Chat. No composer and no callbacks:
 * approvals are disabled and nothing here can answer, retry or drive the Agent.
 */
export function MessagesTab({ messages, running }: { messages: readonly unknown[]; running: boolean }) {
  const dark = useDarkMode();
  return (
    <div className="h-[72vh] overflow-hidden rounded-[var(--radius-card)] border border-border">
      <CloudOsRoot mode={dark ? "dark" : "light"} className="flex h-full min-h-0 flex-col overflow-hidden">
        <CloudOsChatMessages
          messages={messages as UIMessage[]}
          status={running ? "streaming" : "ready"}
          turnActive={running}
          approvalsDisabled
          emptyTitle="还没有消息"
        />
      </CloudOsRoot>
    </div>
  );
}
