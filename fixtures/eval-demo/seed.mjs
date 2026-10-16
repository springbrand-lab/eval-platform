import assert from "node:assert/strict";

const text = (path, mediaType, content) => ({ path, mediaType, contentBase64: Buffer.from(content).toString("base64") });
export const materials = [
  {
    name: "页面参考素材", description: "嵌套目录、HTML 相对资源引用与特殊文件名预览",
    files: [
      text("/index.html", "text/html", '<!doctype html><html lang="zh"><meta charset="utf-8"><link rel="stylesheet" href="styles/site.css"><title>Eval 示例</title><main><img src="images/logo.svg" width="64"><h1>春日任务清单</h1><p>资源预览与相对路径联调</p><a href="docs/readme.md">使用说明</a></main></html>'),
      text("/styles/site.css", "text/css", "body{font-family:system-ui;background:#f4f8f5;color:#163c2a;padding:48px}main{max-width:640px;margin:auto;padding:32px;background:white;border-radius:16px}h1{color:#22865b}"),
      text("/images/logo.svg", "image/svg+xml", '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#22865b"/><path d="m16 33 10 10 22-24" fill="none" stroke="white" stroke-width="6"/></svg>'),
      text("/docs/readme.md", "text/markdown", "# 页面参考\n\n请保留标题、说明和绿色主题，支持移动端。\n\n- HTML 关联 CSS 与 SVG\n- 素材路径包含嵌套目录\n"),
      text("/data/example.json", "application/json", JSON.stringify({ title: "春日任务清单", tasks: ["整理需求", "实现页面", "验证结果"], ready: true }, null, 2)),
      text("/notes/图 #1?.txt", "text/plain", "带空格和特殊字符的文件名，路径原样保留。\n"),
      text("/data/metrics.csv", "text/csv", "name,value\n完成项,3\n剩余项,1\n"),
    ],
  },
  {
    name: "评估参考素材", description: "独立供评估 Agent 使用的评分依据",
    files: [
      text("/rubric.md", "text/markdown", "# 评分标准\n\n总分 100：需求完整性 40、功能正确性 40、可读性 20。\n\n60 分及以上为通过。A 为 85–100，B 为 60–84，C 为 0–59。缺失或无法判断的可选数值使用 null。请根据实际产物评分。\n"),
      text("/expected.json", "application/json", JSON.stringify({ requiredTitle: "春日任务清单", minTasks: 3, mobileFriendly: true }, null, 2)),
    ],
  },
  {
    name: "图片参考素材", description: "PNG 图片与纯文本说明，可与页面素材多选绑定",
    files: [
      { path: "/pixel.png", mediaType: "image/png", contentBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQaov+DwAD1AIDivY4IgAAAABJRU5ErkJggg==" },
      text("/图片说明.txt", "text/plain", "这是用于图片预览的 1×1 PNG 示例。\n"),
    ],
  },
];

const entries = [
  { id: "demo-user-1", message: { role: "user", content: "我们准备制作一个中文任务清单，主题色使用绿色。" }, createdAt: 1 },
  { id: "demo-assistant-1", message: { role: "assistant", content: "好的，页面标题为春日任务清单，保留清楚的任务列表，并适配移动端。" }, createdAt: 2 },
];
export const sessions = [
  { name: "页面需求上下文", description: "JSON 格式的执行历史上下文", format: "json", content: JSON.stringify({ entries }, null, 2) },
  { name: "任务清单上下文", description: "JSONL 格式的执行历史上下文", format: "jsonl", content: entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n" },
];

export const outputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "综合评分", type: "object", additionalProperties: false,
  required: ["score", "passed", "grade", "optionalScore", "reason", "dimensions"],
  properties: {
    score: { title: "总分", description: "依据实际产物评分，范围 0–100", type: "number", minimum: 0, maximum: 100 },
    passed: { title: "是否通过", type: "boolean" },
    grade: { title: "等级", type: "string", enum: ["A", "B", "C"] },
    optionalScore: { title: "可选加分", description: "无法判断时为 null，统计 N 只计有效数值", type: ["number", "null"], minimum: 0, maximum: 10 },
    reason: { title: "评分说明", type: "string" },
    dimensions: {
      title: "分项评分", type: "object", additionalProperties: false, required: ["completeness", "correctness", "readability"],
      properties: {
        completeness: { title: "需求完整性", type: "integer", minimum: 0, maximum: 40 },
        correctness: { title: "功能正确性", type: "integer", minimum: 0, maximum: 40 },
        readability: { title: "可读性", type: "integer", minimum: 0, maximum: 20 },
      },
    },
  },
};

const evalPrompt = "读取被测产物和评估参考素材，按评分 Schema 输出客观结果。score 为 0–100，passed 表示是否达到 60 分，grade 为 A/B/C；optionalScore 没有依据时用 null，reason 用中文说明。分项完整性、正确性、可读性的满分分别为 40、40、20。";
export const promptDatasets = [
  {
    name: "联调示例 · 页面任务 JSON", description: "三条样本，覆盖素材多选、评估素材与可选上下文", format: "json",
    data: [
      { name: "带完整初始化的页面任务", description: "执行素材多选、独立评估素材和单个执行上下文", userPrompt: "参考素材实现春日任务清单，包含至少三条任务，使用绿色主题并适配移动端。将页面文件保存到工作区。", evalPrompt, category: "page", expectedTaskCount: 3, resources: "full" },
      { name: "仅绑定执行素材的页面任务", description: "不绑定上下文，直接从当前 prompt 开始", userPrompt: "根据页面参考素材制作一个中文任务列表，支持添加任务和标记完成，保存 HTML、CSS 和必要脚本。", evalPrompt, category: "page", expectedTaskCount: 3, resources: "material" },
      { name: "无初始化资源的文本任务", description: "资源均为选配，只依靠必填的名称、描述和双 Prompt", userPrompt: "写一份包含需求确认、实现和验收三个阶段的简短开发计划，保存为 plan.md。", evalPrompt, category: "text", resources: "none" },
    ],
  },
  {
    name: "联调示例 · 清单任务 JSONL", description: "两条样本，覆盖 JSONL 上传及上下文选择", format: "jsonl",
    data: [
      { name: "JSONL 上下文任务", description: "使用 JSONL 初始上下文和执行/评估素材", userPrompt: "延续上下文，为春日任务清单补充任务筛选功能，保存可打开的页面。", evalPrompt, category: "page", resources: "jsonl" },
      { name: "独立 JSONL 文本任务", description: "JSONL 中的第二条完整样本", userPrompt: "整理三条页面验收标准，保存到 acceptance.md。", evalPrompt, category: "text", resources: "none" },
    ],
  },
];

export async function seedDemoData({ origin, token, writeOrigin, fetcher = fetch }) {
  assert.ok(token && writeOrigin, "Eval Web token and Origin are required");
  const request = async (path, body, method = body === undefined ? "GET" : "POST") => {
    const response = await fetcher(`${origin}${path}`, {
      method,
      headers: { "X-Eval-Web-Token": token, Origin: writeOrigin, ...(body === undefined || body instanceof FormData ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json();
    assert.ok(response.ok && result.success === true, `Demo request failed: ${path} (${response.status}) ${JSON.stringify(result.errors ?? result.errMsg ?? result.code ?? "")}`);
    return result.msg;
  };
  const ensure = async (path, name, create) => {
    const found = (await request(path)).filter((entry) => entry.name === name);
    assert.ok(found.length <= 1, `Duplicate demo resource: ${name}`);
    return found[0] ?? create();
  };
  const bundle = async (path, name, description) => ensure(path, name, async () => {
    const body = new FormData(); body.set("name", name); body.set("description", description);
    return (await request(path, body)).bundle;
  });
  const materialBundle = await bundle("/api/material-bundles", "联调示例 · 初始素材", "页面、评估参考和图片素材；均可编辑名称和描述");
  const materialRefs = [];
  let checkedFiles = 0;
  const verifyFiles = async (path, files) => {
    const inventory = await request(`${path}/files`);
    assert.equal(inventory.length, files.length);
    for (const file of files) {
      const expected = Buffer.from(file.contentBase64, "base64");
      const entry = inventory.find((item) => item.path === file.path);
      assert.ok(entry, `Missing file: ${file.path}`);
      assert.equal(entry.byteSize, expected.byteLength);
      const response = await fetcher(`${origin}${path}/file?${new URLSearchParams({ path: file.path })}`, {
        headers: { "X-Eval-Web-Token": token }, signal: AbortSignal.timeout(30_000),
      });
      assert.ok(response.ok, `File read failed: ${file.path}`);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected, `File changed: ${file.path}`);
      checkedFiles++;
    }
  };
  for (const material of materials) {
    const path = `/api/material-bundles/${materialBundle.bundleId}/materials`;
    const record = await ensure(path, material.name, () => request(path, material));
    materialRefs.push({ bundleId: materialBundle.bundleId, materialId: record.materialId });
    await verifyFiles(`${path}/${record.materialId}`, material.files);
  }
  const sessionBundle = await bundle("/api/session-bundles", "联调示例 · 初始上下文", "分别提供 JSON 与 JSONL 的只读历史上下文");
  const sessionRefs = [];
  for (const session of sessions) {
    const path = `/api/session-bundles/${sessionBundle.bundleId}/sessions`;
    const record = await ensure(path, session.name, () => request(path, session));
    sessionRefs.push({ bundleId: sessionBundle.bundleId, sessionId: record.sessionId });
    await verifyFiles(`${path}/${record.sessionId}`, [text(`/context.${session.format}`, session.format === "json" ? "application/json" : "application/x-ndjson", session.content)]);
  }
  const schema = await ensure("/api/evaluation-output-schemas", "联调示例 · 综合评分", () => request("/api/evaluation-output-schemas", {
    name: "联调示例 · 综合评分", description: "数值、整数、布尔、枚举、可空数值与嵌套分项", content: JSON.stringify(outputSchema),
  }));
  assert.deepEqual(schema.schema, outputSchema);
  const datasetIds = [];
  let sampleCount = 0;
  for (const dataset of promptDatasets) {
    const rows = dataset.data.map(({ resources, ...data }) => ({
      ...data,
      ...(resources === "none" ? {} : { initialMaterials: resources === "full" ? [materialRefs[0], materialRefs[2]] : [materialRefs[0]], evalInitialMaterials: [materialRefs[1]] }),
      ...(resources === "full" ? { initialSession: sessionRefs[0] } : resources === "jsonl" ? { initialSession: sessionRefs[1] } : {}),
    }));
    const record = await ensure("/api/datasets", dataset.name, async () => (await request("/api/datasets/prompt-import", {
      name: dataset.name, description: dataset.description, format: dataset.format,
      content: dataset.format === "json"
        ? JSON.stringify(dataset.data.map(({ resources, ...data }) => data))
        : dataset.data.map(({ resources, ...data }) => JSON.stringify(data)).join("\n"),
    })).dataset);
    const stored = await request(`/api/datasets/${record.datasetId}/data`);
    assert.equal(stored.length, rows.length);
    for (const row of rows) {
      const match = stored.find((item) => item.name === row.name);
      assert.ok(match);
      const { dataId, initialMaterials, evalInitialMaterials, initialSession, ...content } = match;
      assert.ok(dataId);
      const { initialMaterials: expectedMaterials, evalInitialMaterials: expectedEvalMaterials, initialSession: expectedSession, ...expectedContent } = row;
      assert.deepEqual(content, expectedContent);
      const bindings = {};
      for (const [key, current, expected] of [
        ["initialMaterials", initialMaterials, expectedMaterials],
        ["evalInitialMaterials", evalInitialMaterials, expectedEvalMaterials],
        ["initialSession", initialSession, expectedSession],
      ]) {
        if (current === undefined && expected !== undefined) bindings[key] = expected;
        else assert.deepEqual(current, expected, `Demo binding changed: ${row.name} ${key}`);
      }
      if (Object.keys(bindings).length > 0) {
        await request(`/api/data/${dataId}/initial-resources`, bindings, "PATCH");
      }
      const confirmed = await request(`/api/data/${dataId}`);
      const { dataId: confirmedId, ...confirmedContent } = confirmed;
      assert.equal(confirmedId, dataId);
      assert.deepEqual(confirmedContent, row);
      sampleCount++;
    }
    datasetIds.push(record.datasetId);
  }
  const result = { materialBundleId: materialBundle.bundleId, materials: materials.length, sessionBundleId: sessionBundle.bundleId, sessions: sessions.length, datasetIds, samples: sampleCount, outputSchemaId: schema.outputSchemaId, checkedFiles };
  console.log("Eval demonstration data uploaded and verified:", JSON.stringify(result));
  return result;
}

if (process.argv.includes("--seed")) {
  await seedDemoData({ origin: "http://127.0.0.1:8788", token: process.env.EVAL_WEB_API_TOKEN, writeOrigin: process.env.EVAL_WEB_ORIGIN });
}
