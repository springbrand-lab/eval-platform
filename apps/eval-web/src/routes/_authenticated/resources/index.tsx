import { createFileRoute } from "@tanstack/react-router";
import { ResourcesPage } from "@/features/resources/resources-page";

export const Route = createFileRoute("/_authenticated/resources/")({ component: ResourcesPage });
