import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { render } from "@/test/render";
import { ProjectOutputSchemaPage } from "./project-output-schema-page";

const mocks = vi.hoisted(() => ({ project: vi.fn(), schema: vi.fn() }));
vi.mock("@/api-sdk/projects-api", async (original) => ({ ...await original<object>(), getProject: mocks.project, getProjectOutputSchema: mocks.schema }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));

it("shows the Project-bound Schema document with no catalog read or edit control", async () => {
  mocks.project.mockResolvedValue({ project: { name: "项目" }, evaluation: { digest: "evaluation" }, runSequence: 1, currentRun: null });
  mocks.schema.mockResolvedValue({ reference: { outputSchemaId: "deleted-schema", digest: "a".repeat(64) }, content: { title: "原评分结构", type: "object", properties: { passed: { type: "boolean" } } } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = await render(<TooltipProvider><QueryClientProvider client={client}><ProjectOutputSchemaPage projectId="project" /></QueryClientProvider></TooltipProvider>);
  try {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(view.container.textContent).toContain("原评分结构");
    expect(view.container.textContent).toContain("passed");
    expect(view.container.querySelector("input, textarea")).toBeNull();
    expect(mocks.schema).toHaveBeenCalledWith("project", expect.any(AbortSignal));
  } finally { await view.unmount(); client.clear(); }
});
