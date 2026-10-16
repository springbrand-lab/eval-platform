# Eval 联调数据

`seed.mjs` 集中提供三份初始素材（HTML / CSS / SVG / Markdown / JSON / CSV / PNG / 特殊字符路径）、两份初始上下文（JSON / JSONL）、两个 Prompt 数据集（共五条样本）和一份评分 Schema（数值、整数、布尔、枚举、可空数值及嵌套分项）。样本覆盖执行素材多选、独立评估素材、执行上下文单选和不选择初始化资源。

脚本的 `--seed` 入口只由操作者在受信 API 容器内运行，读取已有的 `EVAL_WEB_API_TOKEN` 与 `EVAL_WEB_ORIGIN`，经正式 HTTP 接口上传。重复运行按演示名称找到原记录并逐项验证，不覆盖已有内容；不创建 Project / Run，不调用模型，不伪造评估结果。只有四类演示输入文件，不属于应用运行时或默认部署行为。

为手工上传导出文件时，可从模块导出的 `materials`、`sessions`、`promptDatasets` 和 `outputSchema` 生成 ZIP、目录和 JSON / JSONL。文件均为模拟内容，不含凭据或业务数据。
