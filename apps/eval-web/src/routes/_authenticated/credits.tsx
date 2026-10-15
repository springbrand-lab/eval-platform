import { createFileRoute } from "@tanstack/react-router";
import { CreditsPage } from "@/features/credits/credits-page";

export const Route = createFileRoute("/_authenticated/credits")({ component: CreditsPage });
