import { Tabs } from "radix-ui";

export type ComparisonViewMode = "evaluation" | "execution";

export function ComparisonViewSwitch({ value, onChange }: {
  value: ComparisonViewMode; onChange: (value: ComparisonViewMode) => void;
}) {
  return <div role="group" aria-label="对比展示视图" className="min-w-0 max-w-full border-b border-border">
    <Tabs.Root value={value} activationMode="manual" onValueChange={(next) => {
      if (next === "evaluation" || next === "execution") onChange(next);
    }}>
      <Tabs.List aria-label="指标展示选择" className="flex min-w-0 items-center gap-5">
        {[
          { value: "evaluation", label: "评估指标" },
          { value: "execution", label: "执行指标" },
        ].map((view) => <Tabs.Trigger key={view.value} value={view.value}
          className="inline-flex min-h-10 shrink-0 items-center whitespace-nowrap border-b-2 border-transparent px-1 text-[13px] font-medium text-text-muted transition-colors hover:text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 data-[state=active]:border-text-strong data-[state=active]:text-text-strong">
          {view.label}
        </Tabs.Trigger>)}
      </Tabs.List>
    </Tabs.Root>
  </div>;
}
