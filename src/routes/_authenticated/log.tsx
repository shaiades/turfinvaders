import { createFileRoute, Navigate } from "@tanstack/react-router";
import { isAdminRole } from "@/lib/roles";
import { laTodayISO } from "@/lib/dates";
import { useAuth } from "@/hooks/useAuth";
import { DailyLogPanel } from "@/components/DailyLogPanel";

export const Route = createFileRoute("/_authenticated/log")({
  head: () => ({ meta: [{ title: "Daily Log — Knockout" }] }),
  component: LogPage,
});

function LogPage() {
  const { role, loading } = useAuth();

  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;

  // Canvassers log inside the Mission page now (2026-08-14); this route
  // stays for leadership. NOTE: /log must remain in CANVASSER_ALLOWED —
  // the AppShell guard fires on pathname before this Navigate runs, and
  // removing it would bounce old bookmarks to /field instead of the Log tab.
  if (role === "canvasser") {
    return <Navigate to="/dashboard" search={{ tab: "log" }} replace />;
  }

  return (
    <div className="space-y-8 max-w-5xl">
      <div>
        <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
          Daily Log
        </div>
        <h1 className="font-display text-2xl text-neon mt-1">DAILY LOG · {laTodayISO()}</h1>
        <p className="text-xs text-muted-foreground mt-2">
          Log your day. Numbers are saved instantly; submitted leads go to the Confirmation Desk.
        </p>
      </div>

      <DailyLogPanel canEditMondayUrl={isAdminRole(role)} />
    </div>
  );
}
