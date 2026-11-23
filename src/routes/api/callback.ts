import { createFileRoute } from "@tanstack/react-router";

/**
 * No-show callback acknowledgment (owner, 2026-11-23) — the server half of
 * the /called/<token> one-tap page the confirmers (Cynthia / Jeni) open from
 * their no-show SMS.
 *
 * GET  ?t=<token> → the escalation behind the token: customer name/phone/
 *   address/appointment, who the token belongs to, whether it (or the other
 *   confirmer's row for the same card) is already marked called.
 * POST {token}    → "I called them". First press claims called_at (UPDATE
 *   ... WHERE called_at IS NULL — concurrent/repeat presses read the stamp
 *   back instead of double-firing), then:
 *     • inserts a webhook_logs 'Owner_Page' row — the 20261117220000 pg_net
 *       trigger pushes it to every owner-role device (Shai, Tyler, Jorge):
 *       "lets us all know they called";
 *     • flips the Monday card's "Confirmer Alert" status to "Called" so the
 *       board shows it too (best-effort: a Monday hiccup never loses the ack).
 *
 * Auth is the token itself: 128-bit opaque hex minted per (card × confirmer)
 * by the DB, carried only inside that confirmer's SMS. No session, no
 * cookies — the confirmation desk isn't logged into the app from a text.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const TOKEN_RE = /^[0-9a-f]{32}$/;

/** Twin of ALERT_* in supabase/functions/monday-live-dispatch/no-show-escalation.ts
 *  (the Deno edge function and this Node route can't share an import —
 *  one copy per runtime, same as the Monday retry helpers). */
const ALERT_COLUMN_TITLE = "confirmer alert";
const ALERT_CALLED_LABEL = "Called";

type EscalationRow = {
  id: string;
  monday_item_id: string;
  board_id: string | null;
  office_location: string | null;
  lead_name: string | null;
  customer_phone: string | null;
  address: string | null;
  appt_time: string | null;
  card_date: string | null;
  confirmer_name: string;
  called_at: string | null;
  notified_at: string | null;
};

async function loadRow(token: string): Promise<EscalationRow | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("no_show_escalations")
    .select(
      "id, monday_item_id, board_id, office_location, lead_name, customer_phone, address, appt_time, card_date, confirmer_name, called_at, notified_at",
    )
    .eq("token", token)
    .maybeSingle();
  return (data as EscalationRow | null) ?? null;
}

/** The other confirmer's row for the same card, if already marked called. */
async function siblingCalled(row: EscalationRow): Promise<{ name: string; at: string } | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("no_show_escalations")
    .select("confirmer_name, called_at")
    .eq("monday_item_id", row.monday_item_id)
    .neq("id", row.id)
    .not("called_at", "is", null)
    .limit(1)
    .maybeSingle();
  const sib = data as { confirmer_name: string; called_at: string } | null;
  return sib ? { name: sib.confirmer_name, at: sib.called_at } : null;
}

function publicShape(row: EscalationRow, sibling: { name: string; at: string } | null) {
  return {
    leadName: row.lead_name,
    customerPhone: row.customer_phone,
    address: row.address,
    apptTime: row.appt_time,
    cardDate: row.card_date,
    office: row.office_location,
    confirmerName: row.confirmer_name,
    calledAt: row.called_at,
    siblingCalled: sibling,
  };
}

/** Best-effort "Called" flip on the Monday card — board shows the ack too.
 *  Column resolved by TITLE per board (weekly clones keep ids, but a rebuilt
 *  board only keeps titles). Any failure is logged and swallowed: the ack
 *  and the owner page already landed. */
async function flipMondayCalled(row: EscalationRow): Promise<void> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    if (!row.board_id) return;
    const { data: settings } = await supabaseAdmin
      .from("system_settings")
      .select("monday_api_token")
      .maybeSingle();
    const token = String(
      (settings as { monday_api_token?: string } | null)?.monday_api_token ?? "",
    ).trim();
    if (!token) return;
    const call = async (query: string) => {
      const resp = await fetch(process.env.MONDAY_API_URL || "https://api.monday.com/v2", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: token,
          "API-Version": "2026-07",
        },
        body: JSON.stringify({ query }),
      });
      return (await resp.json()) as {
        data?: Record<string, unknown>;
        errors?: Array<{ message?: string }>;
      };
    };
    const colsRes = await call(
      `query { boards (ids: [${row.board_id}]) { columns { id title } } }`,
    );
    const boards = (
      colsRes.data as
        | {
            boards?: Array<{ columns?: Array<{ id: string; title: string }> }>;
          }
        | undefined
    )?.boards;
    const alertCol = boards?.[0]?.columns?.find(
      (c) => (c.title || "").trim().toLowerCase() === ALERT_COLUMN_TITLE,
    );
    if (!alertCol) {
      await supabaseAdmin.from("webhook_logs").insert({
        step: "NoShow_Ack_Monday_Skipped",
        data: { itemId: row.monday_item_id, reason: "no Confirmer Alert column" } as never,
      });
      return;
    }
    const vals = JSON.stringify(JSON.stringify({ [alertCol.id]: { label: ALERT_CALLED_LABEL } }));
    const flip = await call(
      `mutation { change_multiple_column_values (board_id: ${row.board_id}, item_id: ${row.monday_item_id}, column_values: ${vals}) { id } }`,
    );
    if (flip.errors?.length) {
      await supabaseAdmin.from("webhook_logs").insert({
        step: "NoShow_Ack_Monday_Error",
        data: { itemId: row.monday_item_id, error: flip.errors[0]?.message ?? "unknown" } as never,
      });
    }
  } catch (e) {
    // The ack already landed — a Monday hiccup is log-only, never surfaced.
    console.error("no-show ack: Monday flip failed", e instanceof Error ? e.message : e);
  }
}

async function handleGet(request: Request): Promise<Response> {
  const token = (new URL(request.url).searchParams.get("t") ?? "").trim().toLowerCase();
  if (!TOKEN_RE.test(token)) return json({ error: "bad token" }, 400);
  const row = await loadRow(token);
  if (!row) return json({ error: "not found" }, 404);
  return json(publicShape(row, await siblingCalled(row)));
}

async function handlePost(request: Request): Promise<Response> {
  let token = "";
  try {
    const body = (await request.json()) as { token?: string };
    token = String(body?.token ?? "")
      .trim()
      .toLowerCase();
  } catch {
    return json({ error: "bad body" }, 400);
  }
  if (!TOKEN_RE.test(token)) return json({ error: "bad token" }, 400);
  const row = await loadRow(token);
  if (!row) return json({ error: "not found" }, 404);

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  // First press wins the claim; a repeat (or a concurrent double-tap) falls
  // through to the idempotent "already called" read-back.
  const { data: claimed } = await supabaseAdmin
    .from("no_show_escalations")
    .update({ called_at: new Date().toISOString() })
    .eq("id", row.id)
    .is("called_at", null)
    .select("called_at")
    .maybeSingle();

  if (!claimed) {
    const fresh = await loadRow(token);
    return json({
      ok: true,
      alreadyCalled: true,
      ...publicShape(fresh ?? row, await siblingCalled(fresh ?? row)),
    });
  }

  // "Lets us all know": one Owner_Page row → pg_net trigger → web push to
  // every owner-role device (Shai, Tyler, Jorge). The insert is the audit
  // trail even if push delivery hiccups.
  const when = [row.card_date, row.appt_time].filter(Boolean).join(" ");
  const bits = [row.customer_phone, row.address, when ? `appt ${when}` : null]
    .filter(Boolean)
    .join(" · ");
  await supabaseAdmin.from("webhook_logs").insert({
    step: "Owner_Page",
    data: {
      title: `📞 ${row.confirmer_name} called ${row.lead_name ?? "the no-show"} back`,
      body: `No Show${row.office_location ? ` — ${row.office_location}` : ""}${bits ? `: ${bits}` : ""}`,
      url: "/close-kombat",
    } as never,
  });
  await supabaseAdmin
    .from("no_show_escalations")
    .update({ notified_at: new Date().toISOString() })
    .eq("id", row.id);

  await flipMondayCalled(row);

  const fresh = await loadRow(token);
  return json({
    ok: true,
    alreadyCalled: false,
    ...publicShape(fresh ?? row, await siblingCalled(fresh ?? row)),
  });
}

export const Route = createFileRoute("/api/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => handleGet(request),
      POST: async ({ request }) => handlePost(request),
    },
  },
});
