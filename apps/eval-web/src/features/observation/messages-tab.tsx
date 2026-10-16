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
    <div className="eval-chat flex min-h-0 flex-1 flex-col">
      <CloudOsRoot mode={dark ? "dark" : "light"} className="flex min-h-0 flex-1 flex-col overflow-hidden">
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
