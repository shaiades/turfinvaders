import { createFileRoute } from "@tanstack/react-router";

/**
 * Weekly Monday.com board rotation (Vercel Cron, Mondays 13:00 UTC = 6am PT).
 *
 * For each office (SD, OC), this week's Block board is found by name — or
 * created by duplicating the structure-only template board — then the
 * create_item + change_column_value webhooks are registered on it (skipped if
 * the registry already has them), system_settings.active_monday_board_* is
 * updated, and webhooks for prior weeks' boards are deregistered. Idempotent:
 * safe to re-run any number of times in a week.
 *
 * Auth: `Authorization: Bearer <CRON_SECRET>` — Vercel Cron sends this
 * automatically when the CRON_SECRET env var is set on the project.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const MONDAY_API = "https://api.monday.com/v2";
const EDGE_URL =
  "https://xogitpqeuwalerxygvjw.supabase.co/functions/v1/monday-live-dispatch?apikey=sb_publishable_ivjX0mrVvSLM1DHfDTDVuw_qHUtGeS2";
const WEBHOOK_EVENTS = ["create_item", "change_column_value"] as const;

type RegistryEntry = {
  board_id: string;
  webhook_id: string;
  event: string;
  registered_at: string;
};

function laToday(): Date {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return new Date(`${fmt.format(new Date())}T00:00:00Z`);
}

/** Monday-of-this-week .. Saturday, formatted like the manual boards: M/DD/YY */
function weekRange(): { start: string; end: string } {
  const d = laToday();
  const dow = d.getUTCDay(); // 0=Sun
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - ((dow + 6) % 7));
  const saturday = new Date(monday);
  saturday.setUTCDate(monday.getUTCDate() + 5);
  const fmt = (x: Date) =>
    `${x.getUTCMonth() + 1}/${String(x.getUTCDate()).padStart(2, "0")}/${String(x.getUTCFullYear()).slice(2)}`;
  return { start: fmt(monday), end: fmt(saturday) };
}

async function monday(token: string, query: string, variables?: Record<string, unknown>) {
  const resp = await fetch(MONDAY_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: token,
      "API-Version": "2024-01",
    },
    body: JSON.stringify(variables ? { query, variables } : { query }),
  });
  const body = (await resp.json()) as { data?: unknown; errors?: unknown };
  if (body.errors) throw new Error(`Monday API: ${JSON.stringify(body.errors).slice(0, 400)}`);
  return body.data as Record<string, unknown>;
}

export const Route = createFileRoute("/api/internal/rotate-boards")({
  server: {
    handlers: {
      GET: async ({ request }) => rotate(request),
      POST: async ({ request }) => rotate(request),
    },
  },
});

async function rotate(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return json({ error: "CRON_SECRET not configured" }, 500);
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return json({ error: "Unauthorized" }, 401);
  }

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const log = async (data: Record<string, unknown>) => {
    await supabaseAdmin
      .from("webhook_logs")
      .insert({ step: "Board_Rotation", data: data as never });
  };

  try {
    const { data: settings } = await supabaseAdmin
      .from("system_settings")
      .select(
        "monday_api_token, monday_template_board_id, monday_webhooks, active_monday_board_sd, active_monday_board_oc",
      )
      .maybeSingle();
    const token = settings?.monday_api_token as string | undefined;
    const templateId = settings?.monday_template_board_id as string | undefined;
    if (!token) return json({ error: "no monday_api_token" }, 500);
    if (!templateId) return json({ error: "no monday_template_board_id" }, 500);
    const registry: RegistryEntry[] = Array.isArray(settings?.monday_webhooks)
      ? (settings!.monday_webhooks as RegistryEntry[])
      : [];

    const { start, end } = weekRange();
    const summary: Record<string, unknown> = { week: `${start} - ${end}` };

    // Existing boards, newest first.
    const boardsData = await monday(
      token,
      "query { boards(limit: 50, order_by: created_at) { id name } }",
    );
    const boards = (boardsData.boards as Array<{ id: string; name: string }>) ?? [];

    const newIds: Record<string, string> = {};
    for (const office of ["SD", "OC"] as const) {
      const existing = boards.find(
        (b) => new RegExp(`^${office}\\s+Block`, "i").test(b.name) && b.name.includes(start),
      );
      let boardId = existing?.id;
      if (!boardId) {
        const name = `${office} Block ${start} - ${end}`;
        const dup = await monday(
          token,
          `mutation ($b: ID!, $n: String!) { duplicate_board(board_id: $b, duplicate_type: duplicate_board_with_structure, board_name: $n) { board { id } } }`,
          { b: templateId, n: name },
        );
        boardId = (dup.duplicate_board as { board: { id: string } }).board.id;
        summary[`${office}_created`] = { boardId, name };
      } else {
        summary[`${office}_existing`] = { boardId, name: existing!.name };
      }
      newIds[office] = String(boardId);

      for (const event of WEBHOOK_EVENTS) {
        const already = registry.some((r) => r.board_id === String(boardId) && r.event === event);
        if (already) continue;
        const created = await monday(
          token,
          `mutation ($b: ID!, $u: String!, $e: WebhookEventType!) { create_webhook(board_id: $b, url: $u, event: $e) { id } }`,
          { b: String(boardId), u: EDGE_URL, e: event },
        );
        registry.push({
          board_id: String(boardId),
          webhook_id: String((created.create_webhook as { id: string }).id),
          event,
          registered_at: new Date().toISOString(),
        });
      }
    }

    // Deregister webhooks for boards that are no longer active.
    const keep: RegistryEntry[] = [];
    const removed: string[] = [];
    for (const entry of registry) {
      if (entry.board_id === newIds.SD || entry.board_id === newIds.OC) {
        keep.push(entry);
        continue;
      }
      try {
        await monday(token, `mutation { delete_webhook(id: ${entry.webhook_id}) { id } }`);
        removed.push(entry.webhook_id);
      } catch {
        // Webhook may already be gone (board deleted/archived) — drop it either way.
        removed.push(`${entry.webhook_id} (delete failed; pruned from registry)`);
      }
    }
    summary.deregistered = removed;

    await supabaseAdmin
      .from("system_settings")
      .update({
        active_monday_board_sd: newIds.SD,
        active_monday_board_oc: newIds.OC,
        monday_webhooks: keep as never,
      })
      .not("id", "is", null);

    await log(summary);
    return json({ ok: true, ...summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await log({ error: message });
    return json({ ok: false, error: message }, 500);
  }
}
