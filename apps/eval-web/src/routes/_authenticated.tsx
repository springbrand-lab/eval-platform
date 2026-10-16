import { createFileRoute } from "@tanstack/react-router";
import { AuthGate } from "@/auth/auth-gate";
import { AppShell } from "@/components/layout/app-shell";

export const Route = createFileRoute("/_authenticated")({
  component: () => (
    <AuthGate>
      <AppShell />
    </AuthGate>
  ),
});
