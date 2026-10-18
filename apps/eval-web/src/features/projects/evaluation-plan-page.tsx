import { OutputFormatPicker } from "@/features/output-schemas/output-format-picker";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { Button, Field, FieldLabel, Input, NativeSelect } from "@springbrand/site-block";
import { toast } from "sonner";
import { agentKeys, listAgentOptions } from "@/api-sdk/agent-configs-api";
import { listOutputSchemas, outputSchemaKeys } from "@/api-sdk/output-schemas-api";
import { projectKeys, replaceEvaluationPlan } from "@/api-sdk/projects-api";
import type { EvaluationPlanInput, ProjectView } from "@/api-sdk/types";
import { ApiError } from "@/api-sdk/client";
import { Page, PageHeader } from "@/components/layout/page";
import { Card, CardBody, CardHeader, DescriptionList } from "@/components/ui/card";
import { ErrorBlock, LoadingBlock, Notice } from "@/components/ui/feedback";
import { useProject } from "./use-project";

function PlanForm({ view }: { view: ProjectView }) {
  const formId = useId();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const projectId = view.project.projectId;
  const agents = useQuery({ queryKey: agentKeys.options("evaluator", "evaluation"), queryFn: ({ signal }) => listAgentOptions("evaluator", "evaluation", signal) });
  const schemas = useQuery({ queryKey: outputSchemaKeys.list(), queryFn: ({ signal }) => listOutputSchemas(signal) });
  const current = view.evaluation?.plan;
  const [agentId, setAgentId] = useState(current?.evaluatorAgentConfig.sourceUserAgentId ?? "");
  const [concurrency, setConcurrency] = useState(current?.evaluationConcurrency ?? 2);
  const [schemaId, setSchemaId] = useState(current?.outputSchema.outputSchemaId ?? "");
  const valid = !!agents.data?.some((option) => option.agentConfig.userAgentId === agentId)
    && Number.isSafeInteger(concurrency) && concurrency > 0 && !!schemas.data?.some((schema) => schema.outputSchemaId === schemaId);
  const save = useMutation({
    mutationFn: (input: EvaluationPlanInput) => replaceEvaluationPlan(projectId, input),
    meta: { silent: true },
    onSuccess: async (next) => {
      queryClient.setQueryData(projectKeys.detail(projectId), next);
      await queryClient.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
      toast.success("评估计划已保存");
      void navigate({ to: "/projects/$projectId", params: { projectId } });
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.code === "PROJECT_EVALUATION_PLAN_LOCKED") {
        await queryClient.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
      }
    },
  });
  return (
    <Card>
      <CardHeader title={current ? "替换评估计划" : "填写评估计划"} />
      <CardBody className="flex flex-col gap-4">
        <fieldset disabled={save.isPending} className="grid gap-4 md:grid-cols-2">
          <Field><FieldLabel htmlFor={`${formId}-agent`}>评估 Agent</FieldLabel>
            <NativeSelect id={`${formId}-agent`} required value={agentId} onChange={(event) => setAgentId(event.target.value)}>
              <option value="" disabled>请选择</option>
              {agentId && !agents.data?.some((option) => option.agentConfig.userAgentId === agentId) && <option value={agentId} disabled>{current?.evaluatorAgentConfig.name ?? agentId}</option>}
              {(agents.data ?? []).map((option) => <option key={option.agentConfig.userAgentId} value={option.agentConfig.userAgentId}>{option.name}</option>)}
            </NativeSelect>
          </Field>
          <Field><FieldLabel htmlFor={`${formId}-concurrency`}>评估并发</FieldLabel>
            <Input id={`${formId}-concurrency`} required type="number" min={1} value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value))} />
          </Field>
          <Field className="md:col-span-2"><FieldLabel htmlFor={`${formId}-schema`}>评估结果格式</FieldLabel>
            <OutputFormatPicker id={`${formId}-schema`} value={schemaId} disabled={save.isPending} onChange={setSchemaId} />
          </Field>
        </fieldset>
        {agents.error && <ErrorBlock error={agents.error} onRetry={() => void agents.refetch()} />}
        {agents.isSuccess && agents.data.length === 0 && <Notice tone="warning">还没有可用的评估 Agent。<Link className="link font-semibold" to="/agents/new">去创建 Agent，并在用途中选择“评估”</Link></Notice>}
        {schemas.error && <ErrorBlock error={schemas.error} onRetry={() => void schemas.refetch()} />}
        {save.error && <ErrorBlock error={save.error} />}
        <div className="flex justify-end">
          <Button disabled={!valid} loading={save.isPending} onClick={() => save.mutate({ userAgentId: agentId, evaluationConcurrency: concurrency, outputSchemaId: schemaId })}>保存</Button>
        </div>
      </CardBody>
    </Card>
  );
}

export function EvaluationPlanPage({ projectId }: { projectId: string }) {
  const view = useProject(projectId);
  const evaluation = view.data?.evaluation;
  return (
    <Page>
      <PageHeader title="评估计划" crumbs={[{ label: "项目管理", to: "/projects" }, { label: view.data?.project.name ?? "项目", to: "/projects/$projectId", params: { projectId } }]} />
      {view.error && <ErrorBlock error={view.error} onRetry={() => void view.refetch()} />}
      {!view.data ? view.isPending && <LoadingBlock /> : (
        <div className="flex flex-col gap-4">
          {evaluation && (
            <Card>
              <CardHeader title="当前评估计划" />
              <CardBody>
                <DescriptionList items={[
                  { label: "评估 Agent", value: evaluation.plan.evaluatorAgentConfig.name },
                  { label: "评估并发", value: evaluation.plan.evaluationConcurrency },
                  { label: "评估结果格式", value: <Link className="link" to="/projects/$projectId/output-schema" params={{ projectId }}>查看</Link> },
                ]} />
              </CardBody>
            </Card>
          )}
          {!evaluation?.lockedAt && <PlanForm key={projectId} view={view.data} />}
        </div>
      )}
    </Page>
  );
}
