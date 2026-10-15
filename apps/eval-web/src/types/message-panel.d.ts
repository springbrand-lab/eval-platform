// @springbrand/message-panel ships TypeScript source that does not pass this app's unused-symbol checks.
// tsconfig `paths` points type checking here; Vite still bundles the real package.
declare module "@springbrand/message-panel" {
  import type { ForwardRefExoticComponent, HTMLAttributes, RefAttributes } from "react";
  import type { UIMessage } from "ai";

  export type MessagePanelStatus = "ready" | "submitted" | "streaming" | "error";

  export interface MessageAdapter<T> {
    getRole(message: T): string;
    getParts(message: T): readonly unknown[];
  }

  export interface MessagePanelProps<T> extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
    messages: readonly T[];
    status: MessagePanelStatus;
    adapter: MessageAdapter<T>;
    emptyTitle?: string;
    emptyDescription?: string;
  }

  export const aiSdkMessageAdapter: MessageAdapter<UIMessage>;
  export const MessagePanel: <T>(props: MessagePanelProps<T> & RefAttributes<HTMLDivElement>) => ReturnType<ForwardRefExoticComponent<object>>;
}

declare module "@springbrand/message-panel/styles.css";
