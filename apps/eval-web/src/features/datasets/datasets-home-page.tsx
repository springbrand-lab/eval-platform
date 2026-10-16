import { Link } from "@tanstack/react-router";
import { ArrowUpRight, FileJson2, Files, FolderArchive, MessagesSquare } from "lucide-react";
import { Page, PageHeader } from "@/components/layout/page";
import { Card, CardBody } from "@/components/ui/card";

const entries = [
  { title: "Prompt 数据集", description: "定义要测什么。管理用例、执行提示词和评估要求，创建项目时选择测试范围。", format: "JSON / JSONL · 支持粘贴内容", to: "/datasets/prompts", icon: Files },
  { title: "初始素材", description: "提供 Agent 需要的输入文件。上传素材包，在用例中分别为执行和评估选择素材。", format: "文件 / 文件夹 / ZIP", to: "/resources/$kind", params: { kind: "material" }, icon: FolderArchive },
  { title: "初始上下文", description: "提供执行前的会话上下文。在用例中选择一份上下文，为执行 Agent 准备起点。", format: "JSON / JSONL 上下文 · 支持 ZIP 导入", to: "/resources/$kind", params: { kind: "session" }, icon: MessagesSquare },
  { title: "评分 Schema", description: "定义评估 Agent 如何输出结果。指定字段、类型和约束，让项目按统一格式展示评估数据。", format: "JSON Schema", to: "/output-schemas", icon: FileJson2 },
] as const;

export function DatasetsHomePage() {
  return <Page><PageHeader title="数据集" description="准备测试用例、输入资源与评分格式。数据准备完成后，即可在项目中复用。" />
    <div className="grid gap-5 md:grid-cols-2">
      {entries.map((entry) => <Link key={entry.title} to={entry.to} params={"params" in entry ? entry.params : undefined} className="group rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Card className="h-full transition-colors group-hover:border-border-strong"><CardBody className="p-6">
          <div className="mb-5 flex items-center justify-between"><span className="flex size-11 items-center justify-center rounded-xl border border-border bg-surface-muted"><entry.icon className="size-5 text-text-secondary" /></span>
            <ArrowUpRight className="size-4 text-text-muted transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" /></div>
          <h2 className="text-base font-semibold text-text-strong">{entry.title}</h2>
          <p className="mt-2 max-w-xl text-sm leading-6 text-text-muted">{entry.description}</p>
          <p className="mt-5 border-t border-border pt-4 text-xs font-medium text-text-secondary">{entry.format}</p>
        </CardBody></Card>
      </Link>)}
    </div>
  </Page>;
}
