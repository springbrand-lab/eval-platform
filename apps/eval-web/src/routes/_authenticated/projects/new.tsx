import { createFileRoute } from "@tanstack/react-router";
import { NewProjectPage } from "@/features/projects/new-project-page";

export const Route = createFileRoute("/_authenticated/projects/new")({ component: NewProjectPage });
