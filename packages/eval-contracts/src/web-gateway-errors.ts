/** Shared by the Web Worker and the full Eval HTTP catalog; no runtime or UI imports. */
export const webGatewayErrorDefinitions = {
  AUTH_UNAUTHENTICATED: { status: 401, message: "Authentication required" },
  EVAL_ACCESS_DENIED: { status: 403, message: "没有 Eval 访问权限" },
  TAKT_UNAVAILABLE: { status: 503, message: "暂时无法连接 takt，请稍后重试" },
  EVAL_API_UNAVAILABLE: { status: 503, message: "Eval API 暂时不可用" },
} as const;

export type WebGatewayErrorCode = keyof typeof webGatewayErrorDefinitions;
