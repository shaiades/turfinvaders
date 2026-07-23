import { createFileRoute } from "@tanstack/react-router";
import { WeeklyPlaybook } from "@/components/WeeklyPlaybook";
import { useAuth } from "@/hooks/useAuth";

export const Route = createFileRoute("/_authenticated/playbook")({
  head: () => ({
    meta: [
      { title: "Weekly Playbook — Turf Invaders" },
      { name: "description", content: "Reverse-engineer your weekly income goal into doors, leads, sits, and sales." },
    ],
  }),
  component: PlaybookPage,
});

// The _authenticated layout route already wraps children in <AppShell> —
// wrapping again here rendered the header/nav twice.
function PlaybookPage() {
  const { user } = useAuth();
  return (
    <div className="mx-auto w-full max-w-5xl space-y-4">
      <header>
        <h1 className="font-display text-2xl text-neon uppercase tracking-widest">
          Weekly Playbook
        </h1>
        <p className="text-xs text-muted-foreground mt-1">
          Set your weekly income goal and we'll reverse-engineer the doors, leads, sits, and sales you need.
        </p>
      </header>
      {user?.id && <WeeklyPlaybook userId={user.id} />}
    </div>
  );
}
