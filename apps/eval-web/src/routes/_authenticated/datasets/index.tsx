import { createFileRoute } from "@tanstack/react-router";
import { DatasetsHomePage } from "@/features/datasets/datasets-home-page";

export const Route = createFileRoute("/_authenticated/datasets/")({ component: DatasetsHomePage });
