# 产物下载失败与 Submission WebSocket 断链：交接摘要

## 问题

2026-10-19 线上 Pipeline Run（Project `7ee18b4b-abc8-4a82-929b-9d4f4769ee1e`，Run `75223d13-247f-4150-91d2-8da6e3be7114`）长期停在“执行中”：已完成的 Subject 证据包导不完（`evidence finalization failed`），部分 Submission 报 `Submission WebSocket closed before terminal status`，资源快照不完整或采集失败，下游评估一直排队。

## 根因

SP 把资源快照与证据轨迹作为 Durable Object RPC 整值返回，超过 32 MiB 上限而稳定失败；同时大数据读写使 SevernAgent isolate 内存超限被重置，连带断开同一 isolate 内的 Submission WebSocket。Eval 侧的次要问题是：证据导出每轮从头下载且无持久进度，`EVIDENCE_NOT_READY` 与真正错误混在一起，断线后的状态校准不可靠。

## 修复位置

修复已实现，记录在 [eval-runtime-review.md](eval-runtime-review.md)：

- R-22：证据导出持久化进度（`evidenceExport`）与跨轮预算；
- R-23：Submission 断线校准与证据就绪（`EVIDENCE_NOT_READY` + `Retry-After`）收尾流程；
- R-24：SP 流式传输、readiness 路由与遗留项（单文件 95 MB 已随 `@springbrand/eval-harness@0.1.0-alpha.4` 生效）。

SP 契约见 [sp-eval-api-requirements.md](sp-eval-api-requirements.md) 与 [eval-sp-harness-protocol.md](eval-sp-harness-protocol.md)。
