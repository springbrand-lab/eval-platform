import { createFileRoute } from "@tanstack/react-router";
import { OutputSchemasPage } from "@/features/output-schemas/output-schemas-page";

export const Route = createFileRoute("/_authenticated/output-schemas/")({ component: OutputSchemasPage });
