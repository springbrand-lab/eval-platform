import { createFileRoute } from "@tanstack/react-router";
import { DatasetsPage } from "@/features/datasets/datasets-page";
export const Route = createFileRoute("/_authenticated/datasets/prompts")({ component: DatasetsPage });
