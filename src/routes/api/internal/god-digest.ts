import { createFileRoute } from "@tanstack/react-router";

/**
 * God Mode morning digest (owner directive 2026-10-01) — Vercel Cron.
 *
 * 6:45am PT, Mon–Sat: five lines from the SAME What-Changed engine the
 * page's rail renders (one computation, two outlets): yesterday's numbers,
 * today's expected cash, top deviations (stale flagged punches ≥7d own a
 * slot until cleared). Zero deviations sends "No deviations." — the
 * all-clear is information; silence would be ambiguity.
 *
 * Scheduling: two UTC slots straddle DST ("45 13,14 * * 1-6"); the LA-hour
 * guard below keeps exactly one of them live in any season (the
 * rotate-boards/weekly-goal doctrine). Dedupe: a webhook_logs claim row per
 * LA date, so the double slot (or a manual re-fire) can never double-ping.
 * Sundays: skipped by the cron expression itself.
 *
 * Delivery: the claim row IS the send — a webhook_logs trigger (migration
 * 20261001200000) POSTs the brief to the notify-owner-digest edge fn via
 * pg_net with the vault notify_secret, the same doctrine as every other
 * push in the app. (Direct Vercel→edge delivery 401s structurally on this
 * project: the two sides' service-key copies do not match.)
 *
 * Auth: `Authorization: Bearer <CRON_SECRET>`; `?force=1` (still
 * secret-gated) bypasses the hour guard for a dry-run, and `?dry=1`
 * composes without sending or claiming.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const DIGEST_STEP = "God_Digest_Sent";

async function handle(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return json({ error: "CRON_SECRET not configured" }, 500);
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return json({ error: "Unauthorized" }, 401);
  }
  const url = new URL(request.url);
  const force = url.searchParams.get("force") === "1";
  const dry = url.searchParams.get("dry") === "1";

  const { laTodayISO, LA_TZ } = await import("@/lib/dates");
  const laHour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: LA_TZ,
      hour: "2-digit",
      hour12: false,
    }).format(new Date()),
  );
  if (!force && laHour !== 6) {
    return json({ skipped: true, reason: `LA hour ${laHour} ≠ 6 (DST twin slot)` });
  }

  const today = laTodayISO();
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  if (!dry) {
    // Claim-first dedupe: the row IS the lock (double slot, manual re-runs).
    const { data: existing } = await supabaseAdmin
      .from("webhook_logs")
      .select("id")
      .eq("step", DIGEST_STEP)
      .eq("data->>date", today)
      .limit(1)
      .maybeSingle();
    if (existing) return json({ skipped: true, reason: `already sent for ${today}` });
  }

  const { composeMorningDigest } = await import("@/lib/deviations.functions");
  const digest = await composeMorningDigest();

  if (dry) return json({ dry: true, ...digest });

  // The insert both claims the LA date and fires the delivery trigger
  // (webhook_logs_zz_god_digest → pg_net → notify-owner-digest).
  const { error: claimErr } = await supabaseAdmin.from("webhook_logs").insert({
    step: DIGEST_STEP,
    data: { date: today, title: digest.title, body: digest.body } as never,
  });
  if (claimErr) return json({ error: claimErr.message }, 500);

  return json({ queued: true, body: digest.body });
}

export const Route = createFileRoute("/api/internal/god-digest")({
  server: {
    handlers: {
      GET: async ({ request }) => handle(request),
      POST: async ({ request }) => handle(request),
    },
  },
});
