import { ApiError } from "@springbrand/http/client";

/** A write may have committed when no usable success or business rejection arrived. */
export function isWriteOutcomeUnknown(error: unknown): boolean {
  return error instanceof ApiError && (error.kind === "network" || error.kind === "timeout"
    || error.kind === "response" || error.status >= 500);
}

/** Chinese text for every Eval API error code; unknown codes fall back to the server's errMsg. */
export const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  REQUEST_INVALID_INPUT: "请求内容无效",
  REQUEST_INVALID_JSON: "请求不是有效的 JSON",
  REQUEST_VALIDATION_FAILED: "填写的内容未通过校验",
  REQUEST_PAYLOAD_TOO_LARGE: "提交的内容太大",
  REQUEST_UNSUPPORTED_MEDIA_TYPE: "不支持的内容类型",
  REQUEST_UNTRUSTED_ORIGIN: "请求来源不受信任",
  REQUEST_NOT_FOUND: "接口不存在",
  REQUEST_RATE_LIMITED: "请求太频繁，请稍后再试",
  AUTH_UNAUTHENTICATED: "登录已失效，请在 takt 中重新登录",
  EVAL_ACCESS_DENIED: "没有 Eval 访问权限，请联系管理员在 takt 中授权",
  INTERNAL_ERROR: "服务出错了，请稍后再试",
  DATABASE_UNAVAILABLE: "数据库暂时不可用，请稍后重试",
  RESPONSE_INVALID: "服务返回了无法识别的结果",
  EVAL_SP_FORBIDDEN: "Eval SP 拒绝了请求",
  EVAL_SP_NOT_FOUND: "Eval SP 中找不到该资源",
  EVAL_SP_CONFLICT: "Eval SP 中的状态冲突",
  EVAL_SP_REQUEST_INVALID: "Eval SP 不接受提交的内容",
  EVAL_SP_REQUEST_FAILED: "Eval SP 请求失败",
  EVAL_SP_UNAVAILABLE: "Eval SP 暂时不可用，请稍后重试",
  AGENT_CONFIG_FROZEN: "这是 Project 的冻结副本，不能修改或删除",
  AGENT_CONFIG_PURPOSE_LOCKED: "Agent 用途在创建后固定，不能切换为另一类",
  AGENT_CONFIG_PURPOSE_MISMATCH: "Agent 用途与当前配置不匹配，请检查评估结果 MCP",
  AGENT_CONFIG_PURPOSE_UNAVAILABLE: "Agent 用途信息暂时不可用，请确认 Eval SP 的 MCP 目录可用后重试",
  PROJECT_NOT_FOUND: "Project 不存在或已删除",
  RESULT_COLLECTION_CONFLICT: "当前记录不能补收：仅支持 Agent 已完成、结果收集失败且运行未被停止的记录",
  PROJECT_BUSY: "Project 还有未结束的 Run",
  PROJECT_IDEMPOTENCY_CONFLICT: "这次创建请求与之前同一个请求的内容不同，请刷新后重新填写",
  PROJECT_NO_ACTIVE_RUN: "这个 Run 已经结束",
  PROJECT_SOURCE_BRANCH_CONFLICT: "Project 属于另一个 Eval SP 分支",
  PROJECT_EVALUATION_PLAN_REQUIRED: "请先为 Project 填写评估计划",
  PROJECT_EVALUATION_PLAN_LOCKED: "评估计划已锁定，不能再修改",
  PROJECT_PLAN_CHANGED: "预览之后计划有变化，请重新预览",
  PROJECT_SAMPLE_NOT_FOUND: "用例不属于这个 Project",
  RUN_NOT_FOUND: "Run 不存在",
  RUN_IDEMPOTENCY_CONFLICT: "这次提交与之前的请求冲突，请重新预览后提交",
  RUN_STOPPED: "Run 已停止",
  RUN_TARGETS_STALE: "目标已变化，请重新预览",
  RUN_TARGETS_EMPTY: "所选范围内没有需要处理的内容",
  RUN_TARGETS_TOO_LARGE: "所选范围太大，请缩小范围",
  RUNTIME_INPUT_INVALID: "运行参数无效",
  RUNTIME_RECORD_CONFLICT: "记录同时被修改，请刷新后重试",
  RUNTIME_PERSISTENCE_UNCONFIRMED: "保存结果未确认，请用同一请求重试",
  PROJECT_SAMPLE_EVALUATION_PROMPT_MISSING: "有用例缺少评审要求（evalPrompt）",
  SAMPLING_NOT_FOUND: "采样不存在",
  SAMPLING_UNAVAILABLE: "所选采样没有成功执行，不能评估",
  EVALUATION_NOT_FOUND: "评估记录不存在",
  DATASET_NOT_FOUND: "数据集不存在",
  DATASET_INPUT_INVALID: "数据集或用例内容无效",
  DATASET_IDENTITY_CONFLICT: "同一 ID 已存在不同内容",
  DATA_NOT_FOUND: "用例不存在",
  DATA_IN_USE: "用例仍在数据集中，不能删除",
  CATALOG_INPUT_INVALID: "名称、说明或 Schema 内容无效",
  CATALOG_PAYLOAD_TOO_LARGE: "内容超过大小上限",
  BUNDLE_RESOURCE_NOT_FOUND: "初始资源不存在",
  BUNDLE_RESOURCE_IN_USE: "初始资源仍被用例引用，不能删除",
  BUNDLE_FILE_NOT_FOUND: "文件不存在",
  BUNDLE_FILE_CONFLICT: "同一文件已存在不同内容",
  BUNDLE_FILE_TOO_LARGE: "文件超过大小上限",
  BUNDLE_FILE_INVALID: "文件内容无效",
  BUNDLE_FILE_UNAVAILABLE: "文件暂时无法读取，请稍后重试",
  OUTPUT_SCHEMA_NOT_FOUND: "评估结果格式不存在",
  SCORE_SYNC_UNCONFIGURED: "当前环境没有配置 Langfuse，不能同步分数",
  METRICS_QUERY_INVALID: "指标查询参数无效",
  NETWORK_ERROR: "网络连接失败",
  REQUEST_TIMEOUT: "请求超时，请稍后重试",
  RESPONSE_TOO_LARGE: "返回内容太大",
};

/** One readable sentence for any thrown value. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    const mapped = ERROR_MESSAGES[error.code];
    const detail = error.code === "REQUEST_VALIDATION_FAILED" && error.errors?.length
      ? `：${error.errors.map((item) => `${item.path || "内容"} ${item.errMsg}`).join("；")}`
      : "";
    if (mapped) return `${mapped}${detail}`;
    return error.message || "请求失败";
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Field errors of a validation failure, keyed by the first path segment. */
export function fieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError) || !error.errors) return {};
  const result: Record<string, string> = {};
  for (const item of error.errors) {
    const key = item.path.split(/[./]/u).filter(Boolean)[0] ?? "";
    result[key] ??= item.errMsg;
  }
  return result;
}
