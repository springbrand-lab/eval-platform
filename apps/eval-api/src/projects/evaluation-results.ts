import type { AgentConfigSnapshot, EvaluationOutputSchema, EvaluationRecord, ProjectPlan, Sampling } from "@eval-platform/eval-contracts";
import type { ProjectSample } from "@eval-platform/eval-runtime";
import { TextReader, ZipWriter } from "@zip.js/zip.js";

export interface ProjectResultsRecord {
  readonly sampling: Sampling;
  readonly evaluation: EvaluationRecord | null;
}

export interface ProjectResultsSnapshot {
  readonly plan: ProjectPlan;
  readonly outputSchema: EvaluationOutputSchema | null;
  readonly samples: AsyncIterable<ProjectSample>;
  readonly records: AsyncIterable<ProjectResultsRecord>;
  close(failed?: boolean): Promise<void>;
}

export type ProjectResultsSource = (projectId: string, signal: AbortSignal) => Promise<ProjectResultsSnapshot>;
export type ProjectResultsExport = ReturnType<typeof createProjectResultsExport>;

function agentMetadata(snapshot: AgentConfigSnapshot) {
  return { sourceUserAgentId: snapshot.sourceUserAgentId, name: snapshot.name };
}

function projectMetadata(plan: ProjectPlan) {
  return {
    ...plan,
    execution: { ...plan.execution, subjectAgentConfig: agentMetadata(plan.execution.subjectAgentConfig) },
    evaluation: plan.evaluation === null ? null : {
      ...plan.evaluation,
      plan: { ...plan.evaluation.plan, evaluatorAgentConfig: agentMetadata(plan.evaluation.plan.evaluatorAgentConfig) },
    },
  };
}

function evaluationMetadata(record: EvaluationRecord) {
  const structured = record.output?.structuredOutput;
  if (structured === undefined) return record;
  const { content: _content, ...reference } = structured;
  return { ...record, output: { ...record.output, structuredOutput: reference } };
}

async function writeEntries(zip: ZipWriter<unknown>, snapshot: ProjectResultsSnapshot, signal: AbortSignal) {
  const root = `project-${encodeURIComponent(snapshot.plan.project.projectId)}`;
  const samplePaths = new Map<string, string[]>();
  const add = async (path: string, content: string) => {
    signal.throwIfAborted();
    await zip.add(path, new TextReader(content), { signal });
  };
  const json = (path: string, value: unknown) => add(path, `${JSON.stringify(value, null, 2)}\n`);
  await json(`${root}/project.json`, projectMetadata(snapshot.plan));
  if (snapshot.outputSchema !== null) await json(`${root}/evaluation-output.schema.json`, snapshot.outputSchema);
  for (const dataset of snapshot.plan.datasets) {
    const path = `${root}/dataset-${encodeURIComponent(dataset.datasetId)}`;
    await json(`${path}/dataset.json`, dataset);
    for (const projectSampleId of dataset.projectSampleIds) {
      const paths = samplePaths.get(projectSampleId) ?? [];
      paths.push(`${path}/sample-${encodeURIComponent(projectSampleId)}`);
      samplePaths.set(projectSampleId, paths);
    }
  }
  for await (const sample of snapshot.samples) {
    const paths = samplePaths.get(sample.projectSampleId);
    if (!paths) throw new Error(`ProjectSample ${sample.projectSampleId} is not bound to a Dataset`);
    for (const path of paths) await json(`${path}/sample.json`, sample);
  }
  const writtenSamplings = new Set<string>();
  for await (const { sampling, evaluation } of snapshot.records) {
    const paths = samplePaths.get(sampling.projectSampleId);
    if (!paths) throw new Error(`Sampling ${sampling.samplingId} has no bound ProjectSample`);
    for (const samplePath of paths) {
      const path = `${samplePath}/sampling-${encodeURIComponent(sampling.samplingId)}`;
      if (!writtenSamplings.has(sampling.samplingId)) await json(`${path}/sampling.json`, sampling);
      if (evaluation !== null) {
        const id = encodeURIComponent(evaluation.evaluationId);
        await json(`${path}/evaluation-${id}.json`, evaluationMetadata(evaluation));
        const structured = evaluation.output?.structuredOutput;
        if (structured !== undefined) await add(`${path}/result-${id}.json`, structured.content);
      }
    }
    writtenSamplings.add(sampling.samplingId);
  }
}

export function createProjectResultsExport(source: ProjectResultsSource) {
  return {
    async open(projectId: string, requestSignal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
      requestSignal.throwIfAborted();
      const lifetime = new AbortController();
      const onRequestAbort = () => lifetime.abort(requestSignal.reason);
      requestSignal.addEventListener("abort", onRequestAbort, { once: true });
      let snapshot: ProjectResultsSnapshot | undefined;
      try {
        snapshot = await source(projectId, lifetime.signal);
        lifetime.signal.throwIfAborted();
      } catch (error) {
        requestSignal.removeEventListener("abort", onRequestAbort);
        await snapshot?.close(true).catch(() => {});
        throw error;
      }
      const saved = snapshot;
      let output!: TransformStreamDefaultController<Uint8Array>;
      const transport = new TransformStream<Uint8Array, Uint8Array>({ start(controller) { output = controller; } });
      const reader = transport.readable.getReader();
      const onAbort = () => output.error(lifetime.signal.reason);
      lifetime.signal.addEventListener("abort", onAbort, { once: true });
      const zip = new ZipWriter(transport.writable, {
        useWebWorkers: false, level: 6, bufferedWrite: false, keepOrder: true, dataDescriptor: true,
      });
      const produce = (async () => {
        try {
          await writeEntries(zip, saved, lifetime.signal);
          lifetime.signal.throwIfAborted();
          await saved.close();
          lifetime.signal.throwIfAborted();
          await zip.close();
        } catch (error) {
          lifetime.abort(error);
          output.error(error);
          await saved.close(true).catch(() => {});
        } finally {
          requestSignal.removeEventListener("abort", onRequestAbort);
          lifetime.signal.removeEventListener("abort", onAbort);
        }
      })();
      let finished = false;
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (finished) return;
            if (next.done) {
              finished = true;
              reader.releaseLock();
              controller.close();
            } else {
              controller.enqueue(next.value);
            }
          } catch (error) {
            if (finished) return;
            finished = true;
            reader.releaseLock();
            controller.error(error);
          }
        },
        async cancel(reason) {
          finished = true;
          lifetime.abort(reason ?? new DOMException("Download cancelled", "AbortError"));
          await reader.cancel(reason).catch(() => {});
          reader.releaseLock();
          await produce;
        },
      }, { highWaterMark: 0 });
    },
  };
}
