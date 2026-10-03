import { createFileRoute } from "@tanstack/react-router";

/**
 * Weekly Action Plan refresh (owner directive 2026-10-01) — Vercel Cron.
 *
 * Runs the Production-board sync (production-jobs.server.ts): mirror +
 * homeowner classification + PM at-risk Monday notifications. Windows:
 *   - Daily 6 AM PT ("refresh daily at 6:00 AM Pacific"), with a 7 AM
 *     catch-up that fires ONLY when 6 AM didn't land (protects "ready by
 *     Monday 8:00 AM").
 *   - Sunday 6 PM PT (the spec's Sunday-evening precompute, so Sunday-night
 *     and early-Monday logins see Fri–Sun schedule/notes changes).
 *
 * Scheduling: vercel.json entries are once-a-day each (repo convention),
 * straddling DST — "0 13/14/15 * * *" for the morning trio and
 * "0 1/2 * * 1" (UTC Monday = LA Sunday evening) for the Sunday pair; the
 * LA-time guard below keeps exactly one slot live in any season (the
 * god-digest doctrine). Dedupe beyond the guard isn't needed: the sync is
 * idempotent (upsert + reconcile) and PM alerts carry their own claim log.
 *
 * Auth: `Authorization: Bearer <CRON_SECRET>`; `?force=1` (still
 * secret-gated) bypasses the time guard for a manual run.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

async function handle(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return json({ error: "CRON_SECRET not configured" }, 500);
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return json({ error: "Unauthorized" }, 401);
  }
  const url = new URL(request.url);
  const force = url.searchParams.get("force") === "1";

  const { laTodayISO, LA_TZ } = await import("@/lib/dates");
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: LA_TZ,
      hour: "2-digit",
      hour12: false,
      weekday: "short",
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  const laHour = Number(parts.hour === "24" ? "0" : parts.hour);
  const laSunday = parts.weekday === "Sun";

  if (!force) {
    const morning = laHour === 6;
    const sundayEvening = laSunday && laHour === 18;
    let catchUp = false;
    if (laHour === 7) {
      // 7 AM runs only when the 6 AM slot didn't land today.
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data: last } = await supabaseAdmin
        .from("webhook_logs")
        .select("data")
        .eq("step", "Production_Jobs_Synced")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      catchUp = (last?.data as { today?: string } | null)?.today !== laTodayISO();
    }
    if (!morning && !sundayEvening && !catchUp) {
      return json({
        skipped: true,
        reason: `LA ${parts.weekday} hour ${laHour}: outside the 6 AM / Sunday 6 PM windows`,
      });
    }
  }

  try {
    const { syncProductionJobs } = await import("@/lib/production-jobs.server");
    const summary = await syncProductionJobs();
    // Kombat Month lock sweep (owner, 2026-10-02): pending contest points
    // lock on wall-clock time (the cancel window), so the daily run must
    // advance them even when nobody pressed Sync. Best-effort: a ledger
    // error must never fail the action-plan refresh.
    let kombat: unknown = null;
    try {
      const { runKombatRecompute } = await import("@/lib/kombat-month.server");
      kombat = await runKombatRecompute();
    } catch (kombatErr) {
      kombat = { error: kombatErr instanceof Error ? kombatErr.message : String(kombatErr) };
    }
    // Rep fighter photos (owner, 2026-10-02): keep Monday profile photos fresh
    // so new reps appear in the admin gallery ready to generate. Photos only —
    // cartoon generation stays admin-triggered (it spends API budget and needs
    // review). Best-effort: a photo hiccup must never fail the plan refresh.
    let repPhotos: unknown = null;
    try {
      const { syncRepPhotos } = await import("@/lib/rep-photos.server");
      repPhotos = await syncRepPhotos();
    } catch (photoErr) {
      repPhotos = { error: photoErr instanceof Error ? photoErr.message : String(photoErr) };
    }
    return json({ ok: true, ...summary, kombat, repPhotos });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Failure trail (cron doctrine: a dead 6 AM run must be visible in the
    // logs, not just a 500 nobody reads). SEPARATE step on purpose — the
    // 7 AM catch-up and "Last updated" read the latest Production_Jobs_Synced
    // row and must not be fooled by a failure entry.
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { laTodayISO: todayFn } = await import("@/lib/dates");
      await supabaseAdmin.from("webhook_logs").insert({
        step: "Production_Jobs_Sync_Failed",
        data: { today: todayFn(), error: message } as never,
      });
    } catch {
      /* the log is best-effort — the 500 below still reports */
    }
    return json({ error: message }, 500);
  }
}

export const Route = createFileRoute("/api/internal/refresh-action-plans")({
  server: {
    handlers: {
      GET: async ({ request }) => handle(request),
      POST: async ({ request }) => handle(request),
    },
  },
});
