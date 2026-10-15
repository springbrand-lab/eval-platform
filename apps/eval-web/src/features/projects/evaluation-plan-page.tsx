import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Lock } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { agentKeys, listAgentOptions } from "@/api-sdk/agent-configs-api";
import { listOutputSchemas, outputSchemaKeys } from "@/api-sdk/output-schemas-api";
import { getProject, projectKeys, replaceEvaluationPlan } from "@/api-sdk/projects-api";
import type { ProjectView } from "@/api-sdk/types";
import { Page, PageHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, DescriptionList } from "@/components/ui/card";
import { ErrorBlock, LoadingBlock, Notice } from "@/components/ui/feedback";
import { Field, Input, Select } from "@/components/ui/form";
import { formatDateTime } from "@/lib/format";

function PlanForm({ view }: { view: ProjectView }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const projectId = view.project.projectId;
  const agents = useQuery({ queryKey: agentKeys.options("evaluator"), queryFn: ({ signal }) => listAgentOptions("evaluator", signal) });
  const schemas = useQuery({ queryKey: outputSchemaKeys.list(), queryFn: ({ signal }) => listOutputSchemas(signal) });
  const current = view.evaluation?.plan;
  const [agentId, setAgentId] = useState(current?.evaluatorAgentConfig.sourceUserAgentId ?? "");
  const [concurrency, setConcurrency] = useState(current?.evaluationConcurrency ?? 2);
  const [schemaId, setSchemaId] = useState(current?.outputSchema.outputSchemaId ?? "");
  const valid = !!agentId && Number.isSafeInteger(concurrency) && concurrency > 0 && !!schemaId;
  const save = useMutation({
    mutationFn: () => replaceEvaluationPlan(projectId, { userAgentId: agentId, evaluationConcurrency: concurrency, outputSchemaId: schemaId }),
    onSuccess: async (next) => {
      queryClient.setQueryData(projectKeys.detail(projectId), next);
      toast.success("评估计划已保存");
      void navigate({ to: "/projects/$projectId", params: { projectId } });
    },
  });
  return (
    <Card>
      <CardHeader title={current ? "替换评估计划" : "填写评估计划"} />
      <CardBody className="flex flex-col gap-4">
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="评委 Agent" required>
            {(id) => (
              <Select id={id} value={agentId} onValueChange={setAgentId}
                options={(agents.data ?? []).map((option) => ({ value: option.agentConfig.userAgentId, label: option.name }))} />
            )}
          </Field>
          <Field label="评估并发" required>
            {(id) => <Input id={id} type="number" min={1} value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value))} />}
          </Field>
          <Field label="评分格式" required>
            {(id) => (
              <Select id={id} value={schemaId} onValueChange={setSchemaId}
                options={(schemas.data ?? []).map((schema) => ({ value: schema.outputSchemaId, label: schema.name }))} />
            )}
          </Field>
        </div>
        <div className="flex justify-end">
          <Button variant="primary" disabled={!valid} loading={save.isPending} onClick={() => save.mutate()}>保存</Button>
        </div>
      </CardBody>
    </Card>
  );
}

export function EvaluationPlanPage({ projectId }: { projectId: string }) {
  const view = useQuery({ queryKey: projectKeys.detail(projectId), queryFn: ({ signal }) => getProject(projectId, signal) });
  const evaluation = view.data?.evaluation;
  return (
    <Page>
      <PageHeader title="评估计划" crumbs={[{ label: "Project", to: "/projects" }, { label: view.data?.project.name ?? "Project", to: "/projects/$projectId", params: { projectId } }]} />
      {view.isPending ? <LoadingBlock /> : view.error ? <ErrorBlock error={view.error} /> : (
        <div className="flex flex-col gap-4">
          {evaluation && (
            <Card>
              <CardHeader title="当前评估计划" />
              <CardBody>
                <DescriptionList items={[
                  { label: "评委 Agent", value: evaluation.plan.evaluatorAgentConfig.name },
                  { label: "评估并发", value: evaluation.plan.evaluationConcurrency },
                  { label: "评分格式 ID", value: <span className="font-mono text-xs">{evaluation.plan.outputSchema.outputSchemaId}</span> },
                  { label: "锁定时间", value: formatDateTime(evaluation.lockedAt) },
                ]} />
              </CardBody>
            </Card>
          )}
          {evaluation?.lockedAt
            ? <Notice tone="warning"><span className="inline-flex items-center gap-1.5"><Lock className="size-4" />首个评估 Run 已经开始，评估计划已锁定，不能再修改。</span></Notice>
            : <PlanForm view={view.data!} />}
        </div>
      )}
    </Page>
  );
}
