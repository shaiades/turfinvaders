import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/AppShell";
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

function PlaybookPage() {
  const { user } = useAuth();
  return (
    <AppShell>
      <div className="mx-auto w-full max-w-5xl p-4 md:p-6 space-y-4">
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
    </AppShell>
  );
}
