// One-tap clock-in on the map screen (Phase 3 §1): the rep opens Active Run,
// taps IN, knocks. Punch-IN only — lunch, attestation and clock-out keep
// their guided flow on Mission's full Time Clock (one honest place for the
// compliance steps). Same insert + cache invalidation as TimeClock's clockIn;
// the server trigger computes review flags regardless, so the lean toast here
// can't dodge a review. Buttons stay hidden until the open-shift read
// settles — the double-punch guard TimeClock uses.

import { Link } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOpenShift } from "@/hooks/useTimeClockSelf";
import { invalidatePunchCaches } from "@/lib/time-clock-keys";
import { laDateISO } from "@/lib/dates";

/** "7:42 AM" in LA wall time, from the punch's timestamptz. */
const fmtPunch = (iso: string) =>
  new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Los_Angeles",
  }).format(new Date(iso));
import { rewardToast } from "@/lib/reward-toast";
import { toast } from "sonner";
import { Play } from "lucide-react";

export function QuickClockIn({
  userId,
  clockHref = "/dashboard",
}: {
  userId: string | undefined;
  /** Where the full Time Clock lives: /dashboard (canvasser) or /mission (captain). */
  clockHref?: "/dashboard" | "/mission";
}) {
  const qc = useQueryClient();
  const open = useOpenShift(userId ?? "", { enabled: !!userId, refetchInterval: 60_000 });

  const clockIn = useMutation({
    mutationFn: async () => {
      if (!userId) throw new Error("Not signed in");
      const now = new Date();
      const { error } = await supabase.from("time_entries").insert({
        user_id: userId,
        clock_in: now.toISOString(),
        log_date: laDateISO(now),
      });
      if (error) throw error;
    },
    onSuccess: () => {
      const laHour = Number(
        new Intl.DateTimeFormat("en-US", {
          hour: "numeric",
          hour12: false,
          timeZone: "America/Los_Angeles",
        }).format(new Date()),
      );
      if (laHour < 7) {
        toast.info("Clocked in early", {
          description: "Before 7:00 AM — your captain or manager will review and approve.",
        });
      } else {
        rewardToast("Clocked in — game on");
      }
      invalidatePunchCaches(qc);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Unknown punch state (loading/error) → render nothing rather than risk a
  // double punch; the HUD's off-the-clock alarm still covers the gap.
  if (!userId || open.isPending || open.isError) return null;

  if (open.data) {
    // On the clock: a quiet receipt that links to the full Time Clock
    // (lunch + clock-out live there).
    return (
      <Link
        to={clockHref}
        // Same cast AppShell's wordmark link uses: /dashboard requires a tab
        // search param and validateSearch coerces whatever arrives.
        search={(clockHref === "/dashboard" ? { tab: "dispatch" } : undefined) as never}
        aria-label={`On the clock since ${fmtPunch(open.data.clock_in)} — open the Time Clock`}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-victory/50 bg-victory/10 px-2.5 text-xs font-semibold text-victory"
      >
        <span aria-hidden className="h-2 w-2 rounded-full bg-victory" />
        IN · {fmtPunch(open.data.clock_in)}
      </Link>
    );
  }

  return (
    <button
      type="button"
      disabled={clockIn.isPending}
      onClick={() => clockIn.mutate()}
      className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-[var(--warning)] bg-[color-mix(in_oklab,var(--warning)_15%,transparent)] px-3 text-xs font-bold uppercase text-[var(--warning)] disabled:opacity-50"
    >
      <Play className="h-3.5 w-3.5" />
      {clockIn.isPending ? "Clocking in…" : "Clock in"}
    </button>
  );
}
