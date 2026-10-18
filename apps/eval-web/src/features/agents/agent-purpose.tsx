import type { EvaluationResultsMcpResolution } from "@/api-sdk/mcp-servers-api";
import type { AgentPurpose } from "@eval-platform/eval-contracts";

export type { AgentPurpose } from "@eval-platform/eval-contracts";

export function AgentPurposeSelector({
  purpose,
  resolution,
  loading,
  error,
  readOnly,
  locked,
  onChange,
}: {
  purpose: AgentPurpose;
  resolution?: EvaluationResultsMcpResolution;
  loading: boolean;
  error: unknown;
  readOnly: boolean;
  locked?: boolean;
  onChange: (purpose: AgentPurpose) => void;
}) {
  const unavailable = resolution?.kind === "unavailable" ? resolution.reason : null;
  return (
    <section aria-label="Agent 用途" data-agent-purpose className="agent-purpose-section w-full border-t border-border pt-4">
      <h2 className="text-sm font-semibold">Agent 用途</h2>
      <p className="mt-1 text-xs text-text-muted">{locked ? "用途在创建后固定，不能改为另一类 Agent。" : "创建时选择用途，保存后不能改为另一类 Agent。"}</p>
      <div role="radiogroup" aria-label="Agent 用途" className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 has-[:checked]:border-primary has-[:checked]:bg-primary/5">
          <input
            type="radio"
            name="agent-purpose"
            value="execution"
            checked={purpose === "execution"}
            disabled={readOnly || locked}
            onChange={() => onChange("execution")}
            className="mt-0.5 size-4 accent-primary"
          />
          <span>
            <span className="block text-sm font-medium text-text-strong">执行 Agent</span>
            <span className="mt-1 block text-xs text-text-muted">用于执行项目任务，不自动提交评估结果。</span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 has-[:checked]:border-primary has-[:checked]:bg-primary/5">
          <input
            type="radio"
            name="agent-purpose"
            value="evaluation"
            checked={purpose === "evaluation"}
            disabled={readOnly || locked}
            onChange={() => onChange("evaluation")}
            className="mt-0.5 size-4 accent-primary"
          />
          <span>
            <span className="block text-sm font-medium text-text-strong">评估 Agent</span>
            <span className="mt-1 block text-xs text-text-muted">自动带上评估结果提交 MCP，供 Evaluator 调用 submit_evaluation。</span>
          </span>
        </label>
      </div>
      {purpose === "evaluation" && (
        <div className="mt-3 text-xs">
          {loading && <p className="text-text-muted">正在查找评估结果 MCP…</p>}
          {!loading && error instanceof Error && <p className="text-danger" role="alert">无法读取评估结果 MCP：{error.message}</p>}
          {!loading && !(error instanceof Error) && unavailable && <p className="text-danger" role="alert">{unavailable}</p>}
          {!loading && !(error instanceof Error) && resolution?.kind === "available" && (
            <p className="text-text-muted">已自动连接：{resolution.server.name}</p>
          )}
        </div>
      )}
    </section>
  );
}
