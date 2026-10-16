import { createFileRoute, redirect } from "@tanstack/react-router";
export const Route = createFileRoute("/_authenticated/datasets/prompts")({ beforeLoad: () => { throw redirect({ to: "/datasets" }); } });
