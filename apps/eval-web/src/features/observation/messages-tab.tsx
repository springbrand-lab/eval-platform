import { aiSdkMessageAdapter, MessagePanel } from "@springbrand/message-panel";
import "@springbrand/message-panel/styles.css";
import type { UIMessage } from "ai";

/** SP's own message renderer, fed a finished Chat: no composer, no actions, nothing that drives the Agent. */
export function MessagesTab({ messages, running }: { messages: readonly unknown[]; running: boolean }) {
  return (
    <div className="eval-message-panel h-[70vh] overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface">
      <MessagePanel<UIMessage>
        messages={messages as UIMessage[]}
        status={running ? "streaming" : "ready"}
        adapter={aiSdkMessageAdapter}
        emptyTitle="还没有消息"
        emptyDescription="Agent 开始运行后，这里会显示会话内容。"
      />
    </div>
  );
}
