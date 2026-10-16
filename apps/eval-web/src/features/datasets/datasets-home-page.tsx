import { Link } from "@tanstack/react-router";
import { FileJson2, Files, FolderArchive, MessagesSquare } from "lucide-react";
import { Page, PageHeader } from "@/components/layout/page";
import { Card, CardBody } from "@/components/ui/card";

const entries = [
  { title: "初始素材", description: "上传素材包与文件，为执行和评估选择素材。", to: "/resources/$kind", params: { kind: "material" }, icon: FolderArchive },
  { title: "初始上下文", description: "上传上下文包，为执行选择一份初始上下文。", to: "/resources/$kind", params: { kind: "session" }, icon: MessagesSquare },
  { title: "Prompt 数据集", description: "导入 JSON / JSONL，管理样本与两类 Prompt。", to: "/datasets/prompts", icon: Files },
  { title: "评分 Schema", description: "上传 JSON Schema，定义评估输出与统计字段。", to: "/output-schemas", icon: FileJson2 },
] as const;

export function DatasetsHomePage() {
  return <Page><PageHeader title="数据集" />
    <div className="grid gap-4 sm:grid-cols-2">
      {entries.map((entry) => <Link key={entry.title} to={entry.to} params={"params" in entry ? entry.params : undefined} className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Card className="h-full transition-colors hover:border-border-strong"><CardBody>
          <entry.icon className="mb-4 size-5 text-text-muted" /><h2 className="font-semibold">{entry.title}</h2>
          <p className="mt-2 text-sm text-text-muted">{entry.description}</p>
        </CardBody></Card>
      </Link>)}
    </div>
  </Page>;
}
