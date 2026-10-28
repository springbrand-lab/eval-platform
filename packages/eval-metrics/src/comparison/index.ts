import { equalJson } from "@eval-platform/eval-contracts";
import { aggregateMetrics } from "../aggregation/index.js";
import type { MetricsEvaluation } from "../aggregation/model.js";
import type { EvaluationOutputRead, EvaluationOutputReader } from "../evaluators/index.js";
import { selectOutputFields } from "../evaluators/fields.js";
import type { OutputFieldDefinition, OutputObservation } from "../evaluators/model.js";
import { record, text } from "../json.js";
import { identifier, indexBy, MetricsEntityNotFoundError, MetricsQueryError, MetricsSourceError, prepareFacts } from "../reporting/index.js";
import type { MetricsFacts } from "../reporting/model.js";
import type {
  ComparisonDataRow, ComparisonField, ComparisonProject, ComparisonProjectValues,
  ProjectComparison, ProjectComparisonQuery, ProjectComparisonSource,
} from "./model.js";

function validateQuery(input: ProjectComparisonQuery): ProjectComparisonQuery {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new MetricsQueryError("Comparison query must be an object");
  if (!Array.isArray(input.projectIds) || input.projectIds.length < 2) throw new MetricsQueryError("projectIds must contain at least two Projects");
  const projectIds = Array.from(input.projectIds, (id) => identifier(id, "projectId"));
  if (new Set(projectIds).size !== projectIds.length) throw new MetricsQueryError("projectIds must not contain duplicates");
  if (input.jsonPointer !== undefined && (typeof input.jsonPointer !== "string"
    || !/^(?:\/(?:[^~]|~[01])*)?$/.test(input.jsonPointer))) {
    throw new MetricsQueryError("jsonPointer must be a JSON Pointer");
  }
  return {
    projectIds,
    ...(input.datasetId === undefined ? {} : { datasetId: identifier(input.datasetId, "datasetId") }),
    ...(input.jsonPointer === undefined ? {} : { jsonPointer: input.jsonPointer }),
  };
}

function isScored(observation: OutputObservation): boolean {
  return observation.value !== null && observation.kinds.length > 0;
}

function prepareProject(facts: MetricsFacts, projectId: string) {
  const view = prepareFacts(facts, { projectId });
  const samples = new Map([...view.sampleById.values()].map((sample) => [sample.dataId, sample]));
  const samplings = new Map(view.samplings.map((sampling) => [sampling.samplingId, sampling]));
  const evaluations = view.evaluationsOf(view.samplings);
  const fields = selectOutputFields([view.outputs.fields, ...evaluations.map((record) => view.outputs.read(record).facts.fields)]);
  const scored = new Map<string, Map<string, MetricsEvaluation[]>>();
  for (const record of evaluations) {
    const sampling = samplings.get(record.samplingId)!;
    const sample = view.sampleById.get(sampling.projectSampleId)!;
    const pointers = new Set(view.outputs.read(record).facts.observations
      .filter(isScored).map((observation) => observation.jsonPointer));
    for (const pointer of pointers) {
      let data = scored.get(pointer);
      if (!data) scored.set(pointer, data = new Map());
      const records = data.get(sample.dataId) ?? [];
      records.push(record);
      data.set(sample.dataId, records);
    }
  }
  return { view, samples, fields, scored };
}

type PreparedProject = ReturnType<typeof prepareProject>;

function compatible(fields: readonly OutputFieldDefinition[]): boolean {
  const kinds = fields.map((field) => field.kinds.map((kind) => kind === "integer" ? "number" : kind).join(","));
  if (!kinds.every((value) => value === kinds[0])) return false;
  const values = fields[0]!.values.filter((value) => typeof value !== "boolean");
  return !fields[0]!.kinds.includes("enum") || fields.every((field) => {
    const domain = field.values.filter((value) => typeof value !== "boolean");
    return domain.length === values.length && domain.every((value) => values.includes(value));
  });
}

function projectInfo({ view }: PreparedProject): ComparisonProject {
  return {
    project: view.project,
    executionAgentName: view.plan.execution.subjectAgentConfig.name,
    evaluationAgentName: view.plan.evaluation?.plan.evaluatorAgentConfig.name ?? null,
    framework: view.plan.execution.harness.framework,
    executionModel: text(record(view.plan.execution.subjectAgentConfig.body.setting)?.model) ?? null,
  };
}

function scoredOutput(reader: EvaluationOutputReader, field: ComparisonField | null): EvaluationOutputReader {
  const fields = new Map(field === null ? [] : [[field.jsonPointer, field] as const]);
  const reads = new Map<string, EvaluationOutputRead>();
  return {
    schema: reader.schema, fields,
    read(record) {
      const cached = reads.get(record.evaluationId);
      if (cached) return cached;
      const result = reader.read(record);
      const projected = {
        ...result,
        facts: {
          fields,
          observations: result.facts.observations.filter((observation) => observation.jsonPointer === field?.jsonPointer && isScored(observation)),
        },
      };
      reads.set(record.evaluationId, projected);
      return projected;
    },
  };
}

function summarize(project: PreparedProject, field: ComparisonField | null, dataIds: readonly string[]): ComparisonProjectValues {
  const samples = dataIds.map((id) => project.samples.get(id)!);
  const evaluations = field === null ? [] : dataIds.flatMap((id) => project.scored.get(field.jsonPointer)?.get(id) ?? []);
  const samplingIds = new Set(evaluations.map((record) => record.samplingId));
  const samplings = project.view.samplingsOf(samples).filter((sampling) => samplingIds.has(sampling.samplingId));
  const summary = aggregateMetrics({
    bindings: {
      datasets: new Set(samples.flatMap((sample) => sample.datasetIds)).size, data: samples.length, projectSamples: samples.length,
    },
    samplings, evaluations, outputs: scoredOutput(project.view.outputs, field),
  });
  const resources = summary.executionAgent;
  return {
    projectId: project.view.project.projectId, dataCount: summary.counts.data,
    samplingCount: summary.counts.samplings, evaluationCount: summary.counts.evaluations,
    score: field === null || evaluations.length === 0 ? null : summary.evaluationOutputs.fields.find((item) => item.jsonPointer === field.jsonPointer) ?? null,
    resources: {
      chargedUnits: resources.costs.chargedUnits,
      chargedUnitsPerAgent: resources.distribution.costs.chargedUnits,
      agentDurationMs: summary.execution.agentDurationMs,
      cacheHitRate: resources.cacheHitRate,
      toolSuccessRate: resources.trajectory.toolSuccessRate,
    },
  };
}

function datasetIdsOf(projects: readonly PreparedProject[], dataId: string): readonly string[] {
  return [...new Set(projects.flatMap((project) => project.samples.get(dataId)!.datasetIds))];
}

function dataRow(projects: readonly PreparedProject[], field: ComparisonField, dataId: string): ComparisonDataRow {
  const samples = projects.map((project) => project.samples.get(dataId)!);
  const values = projects.map((project, index) => ({
    ...summarize(project, field, [dataId]),
    projectSampleId: samples[index]!.projectSampleId,
    samplingIds: [...new Set(project.scored.get(field.jsonPointer)!.get(dataId)!.map((record) => record.samplingId))].sort(),
  }));
  const means = values.map((value) => value.score?.numeric?.mean ?? null);
  const spread = means.every((mean): mean is number => mean !== null) ? Math.max(...means) - Math.min(...means) : null;
  const distributions = values.map((value) => value.score?.distribution.map(({ value, share }) => ({ value, share })));
  return {
    dataId, data: samples[0]!.data, datasetIds: datasetIdsOf(projects, dataId),
    inputChanged: samples.some((sample) => !equalJson(sample.data, samples[0]!.data)),
    projects: values, spread, different: (spread !== null && spread !== 0) || distributions.some((value) => !equalJson(value, distributions[0])),
  };
}

export function createProjectComparison(dependencies: { readonly source: ProjectComparisonSource }): ProjectComparison {
  return {
    async getComparison(input) {
      const query = validateQuery(input);
      const facts = structuredClone(await dependencies.source.read([...query.projectIds]));
      const byProject = indexBy(facts, (item) => item.plan.project.projectId, "Project");
      if ([...byProject.keys()].some((id) => !query.projectIds.includes(id))) throw new MetricsSourceError("Source returned an unrequested Project");
      const projects = query.projectIds.map((id) => {
        const project = byProject.get(id);
        if (!project) throw new MetricsEntityNotFoundError("project", id);
        return prepareProject(project, id);
      });
      if (projects.some((project) => project.view.project.ownerUserId !== projects[0]!.view.project.ownerUserId)) {
        throw new MetricsSourceError("Source returned Projects belonging to different owners");
      }
      const intersections = new Map<string, readonly string[]>();
      const fields: ComparisonField[] = [];
      for (const [pointer] of projects[0]!.fields) {
        const definitions = projects.map((project) => project.fields.get(pointer));
        if (!definitions.every((definition): definition is OutputFieldDefinition => definition !== undefined) || !compatible(definitions)) continue;
        const dataIds = [...projects[0]!.scored.get(pointer)?.keys() ?? []]
          .filter((id) => projects.every((project) => project.scored.get(pointer)?.has(id))).sort();
        if (dataIds.length === 0) continue;
        const definition = selectOutputFields(definitions.map((definition) => new Map([[pointer, definition]]))).get(pointer)!;
        fields.push({ ...definition, dataCount: dataIds.length });
        intersections.set(pointer, dataIds);
      }
      const selectedField = query.jsonPointer === undefined ? fields[0] ?? null : fields.find((field) => field.jsonPointer === query.jsonPointer) ?? null;
      const allDataIds = selectedField === null ? [] : intersections.get(selectedField.jsonPointer)!;
      const memberships = new Map(allDataIds.map((dataId) => [dataId, datasetIdsOf(projects, dataId)]));
      const dataIds = query.datasetId === undefined ? allDataIds : allDataIds.filter((id) => memberships.get(id)!.includes(query.datasetId!));
      const rows = selectedField === null ? [] : dataIds.map((dataId) => dataRow(projects, selectedField, dataId));
      const datasets = new Map(projects.flatMap((project) => project.view.plan.datasets.map((dataset) => [dataset.datasetId, dataset] as const)));
      return {
        projects: projects.map(projectInfo), fields, selectedField, datasetId: query.datasetId ?? null,
        datasets: [...datasets.values()].flatMap((dataset) => {
          const dataCount = allDataIds.filter((id) => memberships.get(id)!.includes(dataset.datasetId)).length;
          return dataCount === 0 ? [] : [{ datasetId: dataset.datasetId, name: dataset.name, dataCount }];
        }),
        summary: projects.map((project) => summarize(project, selectedField, dataIds)), rows,
      };
    },
  };
}
