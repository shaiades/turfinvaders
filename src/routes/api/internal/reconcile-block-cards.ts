import { createFileRoute } from "@tanstack/react-router";

/**
 * block_cards reconcile (Vercel Cron) — rule N backstop.
 *
 * The rep portal (useMyLeads) reads public.block_cards, the mirror of Monday's
 * live people6/status. That mirror is normally kept current by the
 * monday-live-dispatch change_column_value webhook — but a single DROPPED
 * webhook delivery leaves block_cards silently stale, and rule E (the portal
 * lists every lead where the rep is on people6, no matter who assigned it)
 * quietly stops being true for that rep (the Leonardo Favero incident: an
 * Office Appt assigned by the office never surfaced in his portal).
 *
 * Webhook registration itself is sound — rotate-boards registers create_item +
 * change_column_value on both active boards and re-creates dropped hooks in its
 * daily self-heal. What was missing was a periodic REconcile of the live board
 * back into block_cards to catch a delivery Monday never made. This route runs
 * syncBoardsToBlockCards({ scope: "active" }) a few times across the working day
 * so any drift self-heals within one cycle, independent of webhook reliability.
 *
 * Auth: `Authorization: Bearer <CRON_SECRET>` (Vercel Cron sends it when the
 * CRON_SECRET env var is set) — same scheme as rotate-boards. Idempotent: the
 * sync is a full-state upsert keyed by monday_item_id.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export const Route = createFileRoute("/api/internal/reconcile-block-cards")({
  server: {
    handlers: {
      GET: async ({ request }) => handle(request),
      POST: async ({ request }) => handle(request),
    },
  },
});

async function handle(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return json({ error: "CRON_SECRET not configured" }, 500);
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return json({ error: "Unauthorized" }, 401);
  }
  try {
    const { syncBoardsToBlockCards } = await import("@/lib/block-cards.server");
    const summary = await syncBoardsToBlockCards({ scope: "active" });
    return json({ ok: true, ...summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Best-effort: a reconcile hiccup is logged in the response, never a 200 lie.
    return json({ ok: false, error: message }, 500);
  }
}
