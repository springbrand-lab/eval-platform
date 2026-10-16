// @springbrand/message-panel ships TypeScript source that does not pass this app's unused-symbol checks.
// tsconfig `paths` points type checking here; Vite still bundles the real package.
declare module "@springbrand/message-panel/cloud-os" {
  import type { ReactNode } from "react";
  import type { UIMessage } from "ai";

  export type CloudOsMode = "light" | "dark";
  export type CloudOsChatStatus = "ready" | "submitted" | "streaming" | "error";

  export function CloudOsRoot(props: { mode?: CloudOsMode; className?: string; children?: ReactNode }): ReactNode;

  export function CloudOsChatMessages(props: {
    messages: readonly UIMessage[];
    status: CloudOsChatStatus;
    turnActive?: boolean;
    approvalsDisabled?: boolean;
    emptyTitle?: string;
    constrainWidth?: boolean;
  }): ReactNode;
}

declare module "@springbrand/message-panel/cloud-os.css";
