import { createFileRoute } from "@tanstack/react-router";
import { AgentEditorPage } from "@/features/agents/agent-editor-page";

export const Route = createFileRoute("/_authenticated/agents/new")({ component: () => <AgentEditorPage /> });
