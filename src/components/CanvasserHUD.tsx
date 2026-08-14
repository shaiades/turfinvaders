import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { weeklyPoints } from "@/lib/pay";
import { laTodayISO } from "@/lib/dates";
import { RankPill } from "@/components/RankPill";
import { metricText } from "@/components/arcade";

/**
 * The canvasser HUD — a one-line score strip pinned inside the sticky header
 * so a canvasser mid-street never hunts for their number: today's points
 * (PM = 1, Sale = 2 — same weeklyPoints math as the pay engine reads),
 * today's called-in leads, and their SCCE rank. Renders ONLY for canvassers;
 * every other role gets zero extra DOM.
 */
export function CanvasserHUD({ userId }: { userId: string }) {
  const today = laTodayISO();

  const { data } = useQuery({
    queryKey: ["canvasser_hud", userId, today],
    queryFn: async () => {
      const [logsR, profileR] = await Promise.all([
        supabase
          .from("daily_logs")
          .select("demos_sits, sales, leads_called_in")
          .eq("canvasser_id", userId)
          .eq("log_date", today),
        supabase.from("profiles").select("current_rank").eq("id", userId).maybeSingle(),
      ]);
      if (logsR.error) throw logsR.error;
      const t = (logsR.data ?? []).reduce(
        (a, r) => ({
          sits: a.sits + (r.demos_sits ?? 0),
          sales: a.sales + (r.sales ?? 0),
          called: a.called + (r.leads_called_in ?? 0),
        }),
        { sits: 0, sales: 0, called: 0 },
      );
      return {
        points: weeklyPoints(t.sits, t.sales),
        called: t.called,
        rank: profileR.data?.current_rank ?? "Jr. Silver",
      };
    },
    staleTime: 10_000,
  });

  // New pings land on the HUD the moment they hit daily_logs.
  useRealtimeInvalidate({
    channel: "canvasser-hud",
    tables: ["daily_logs"],
    invalidateKeys: [["canvasser_hud", userId, today]],
  });

  const points = data?.points ?? 0;
  const called = data?.called ?? 0;

  return (
    <div className="border-t border-border/60 px-4 py-1.5 flex items-center justify-between gap-3 text-[10px] font-display uppercase tracking-widest">
      <RankPill rank={data?.rank ?? "Jr. Silver"} />
      <div className="flex items-center gap-4 tabular-nums">
        <span className="text-muted-foreground">
          Leads Today · <span className={metricText(called, "text-neon")}>{called}</span>
        </span>
        <span className="text-muted-foreground">
          Pts Today · <span className={metricText(points, "text-victory")}>{points}</span>
        </span>
      </div>
    </div>
  );
}
