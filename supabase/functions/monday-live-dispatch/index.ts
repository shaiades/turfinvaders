import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { fetchItemBatched } from './monday.ts'
import {
  buildBlockCardRow,
  copyBaseName,
  findSaleOutcomeCol,
  findSalePriceCol,
  isCopyName,
  mondayOfISO,
  parseBoardWeekStart,
  parseMoney,
  SOLD_VALUES,
  type MondayCol,
} from './block-cards.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function normalizeName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ')
}

function todayLA(): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
  })
  return fmt.format(new Date())
}

/** LA calendar date of a timestamp — the metric day an old marker counted
 *  on. Markers written before 2026-08 don't carry metric_date in data, but
 *  their created_at IS the moment their counters were written. */
function laDateOf(ts: string | null | undefined): string | null {
  if (!ts) return null
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return null
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d)
}

/** A Card_Outcome_Recorded / Card_OL_Recorded row, as read back. */
type MarkerRow = {
  data: Record<string, unknown> | null
  created_at: string | null
}

/**
 * Schedule board outcome mapper.
 * Returns which daily_metrics counter to bump based on the changed column
 * label and the new cell value. Match is case-insensitive.
 */
type ScheduleBucket = 'sit' | 'sales' | 'resets' | 'blowouts' | 'ctc' | null

/** Owner's core-product list (2026-07-27). The dropdown label for Paint is
 *  "Stucco/Paint"; everything not listed here is non-core. Non-core results
 *  still count (and pay) — they just also tick the non_core tally. */
const CORE_TOKENS = ['roof', 'stucco/paint', 'paint', 'coolwall', 'windows', 'flat roof', 'trim', 'eaves/fascia']

/** Canvasser result state, straight from the Setter Report's source columns:
 *  Canvass Stats (id `color`, ONE value per card: Sit / Sale / Reset /
 *  Blowout / CTC — the marketing "mothership" numbers), Products (core vs
 *  non-core), and the OL column as an independent flag (a card can be an
 *  outside lead AND have a Canvass Stats result). The BO/RS/PM/Rep Stats
 *  columns are closer-side stats and never feed canvasser counters. */
function deriveCanvassState(cols: MondayCol[]) {
  const colText = (id: string, title: string) => {
    const c =
      cols.find((c) => c.id === id || c.column?.id === id) ??
      cols.find((c) => (c.column?.title || '').trim().toLowerCase() === title)
    return (c?.text || '').trim()
  }
  const cs = colText('color', 'canvass stats').toLowerCase()
  const bucket: ScheduleBucket =
    cs === 'sit' ? 'sit'
    : cs === 'sale' || cs === 'reload' ? 'sales'
    : cs === 'reset' ? 'resets'
    : cs === 'blowout' ? 'blowouts'
    : cs === 'ctc' ? 'ctc'
    : null
  const tokens = colText('dropdown', 'products')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  const nonCore = !!bucket && tokens.length > 0 && !tokens.some((t) => CORE_TOKENS.includes(t))
  const olText = colText('status_3', 'ol').toLowerCase()
  const ol = olText === 'ol' || olText === 'outside lead'
  return { bucket, nonCore, ol }
}

// MondayCol, SOLD_VALUES, parseMoney, findSalePriceCol, findSaleOutcomeCol
// moved to block-cards.ts (shared with the Close Kombat snapshot).

/** deny_reason marker for leads voided by an automatic Monday sale revert.
 *  Only leads carrying this exact marker may be auto re-confirmed on a
 *  re-sale — human denials at the Confirmation Desk are never overridden. */
const REVERT_REASON = 'Monday sale status reverted'

/** Canvass Stats bucket → daily_logs counter deltas (payroll + Weekly
 *  Results feed). A sale implies a sit (demos_sits includes sold sits — the
 *  display subtracts). non_core and one_legs are applied separately.
 *  leads_called_in is credited once per Monday item. */
const DAILY_LOG_VECS: Record<string, Record<string, number>> = {
  sit: { demos_sits: 1 },
  sales: { demos_sits: 1, sales: 1 },
  resets: { future_leads: 1 },
  blowouts: { no_demo: 1 },
  ctc: { ctc: 1 },
}

const DAILY_LOG_KEYS = [
  'demos_sits', 'sales', 'no_demo', 'future_leads', 'ctc', 'non_core',
  'one_legs', 'leads_called_in',
] as const

/** Canvass Stats bucket → daily_metrics outcome column (legacy names:
 *  Sit lives in pitch_missed). CTC has no daily_metrics mirror. */
const METRIC_COL: Record<string, 'pitch_missed' | 'sales' | 'resets' | 'blowouts'> = {
  sit: 'pitch_missed',
  sales: 'sales',
  resets: 'resets',
  blowouts: 'blowouts',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const supabaseAdmin = createClient(supabaseUrl, supabaseKey)

  try {
    await supabaseAdmin.from('webhook_logs').insert({ step: '0_Endpoint_Hit' })

    const text = await req.text()
    if (!text) {
      await supabaseAdmin.from('webhook_logs').insert({ step: '1_Error', data: { msg: 'Empty body' } })
      return new Response('Empty', { status: 200, headers: corsHeaders })
    }

    const body = JSON.parse(text)
    if (body.challenge) {
      return new Response(JSON.stringify({ challenge: body.challenge }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Optional shared-secret gate, soft rollout: no-op until MONDAY_WEBHOOK_SECRET
    // is set in the function secrets; then mismatches are logged but allowed until
    // MONDAY_WEBHOOK_ENFORCE_SECRET=true, so existing Monday integrations keep
    // working while their webhook URLs are updated to include ?secret=...
    const expectedSecret = Deno.env.get('MONDAY_WEBHOOK_SECRET') ?? ''
    if (expectedSecret) {
      const presentedSecret =
        req.headers.get('x-monday-secret') ?? new URL(req.url).searchParams.get('secret') ?? ''
      if (presentedSecret !== expectedSecret) {
        const enforceSecret =
          (Deno.env.get('MONDAY_WEBHOOK_ENFORCE_SECRET') ?? '').toLowerCase() === 'true'
        await supabaseAdmin.from('webhook_logs').insert({
          step: 'Secret_Check_Failed',
          data: { enforced: enforceSecret },
        })
        if (enforceSecret) {
          return new Response('Unauthorized', { status: 401, headers: corsHeaders })
        }
      }
    }

    const event = body?.data?.event || body?.event || body
    const pulseId = event?.pulseId || event?.itemId || event?.pulse_id
    const boardId = String(event?.boardId || event?.board_id || '')
    const changedColumnId: string | undefined = event?.columnId || event?.column_id
    const isCreateEvent = event?.type === 'create_pulse'

    // ── Retry guard ── Monday redelivers failed webhooks once per minute for
    // 30 minutes. Redeliveries carry the first delivery's uuid in
    // originalTriggerUuid (null on the first delivery) under a fresh
    // triggerUuid, so the stable dedupe key is originalTriggerUuid first.
    // The counter writes below are transition deltas, so a re-applied
    // delivery would double-count. First successful delivery wins.
    const triggerUuid: string | undefined =
      event?.originalTriggerUuid || event?.triggerUuid || body?.triggerUuid
    if (triggerUuid) {
      const { data: seen } = await supabaseAdmin
        .from('webhook_logs')
        .select('id')
        .eq('step', 'Event_Processed')
        .contains('data', { triggerUuid })
        .limit(1)
      if ((seen?.length ?? 0) > 0) {
        await supabaseAdmin.from('webhook_logs').insert({
          step: 'Event_Retry_Skipped',
          data: { triggerUuid, pulseId: pulseId ? String(pulseId) : null },
        })
        return new Response('Duplicate delivery', { status: 200, headers: corsHeaders })
      }
    }
    const statusFromEvent: string | undefined =
      event?.value?.label?.text ||
      event?.value?.label ||
      event?.value?.text ||
      event?.columnValue?.label?.text
    const previousStatusFromEvent: string | undefined =
      event?.previousValue?.label?.text ||
      event?.previousValue?.label ||
      event?.previousValue?.text ||
      event?.previous_value?.label?.text ||
      event?.previous_value?.label ||
      event?.previous_value?.text

    await supabaseAdmin.from('webhook_logs').insert({
      step: '2_Payload_Parsed',
      data: { pulseId, boardId, changedColumnId, statusFromEvent, previousStatusFromEvent, isCreateEvent, triggerUuid: triggerUuid ?? null },
    })

    if (!pulseId) {
      await supabaseAdmin.from('webhook_logs').insert({ step: 'Error_No_PulseId', data: { event } })
      return new Response('No pulseId', { status: 200, headers: corsHeaders })
    }

    // Step 2b: Load active board IDs from system_settings
    const { data: settingsRow } = await supabaseAdmin
      .from('system_settings')
      .select('*')
      .maybeSingle()

    const activeBoardOC = String((settingsRow as any)?.active_monday_board_oc || '')
    const activeBoardSD = String((settingsRow as any)?.active_monday_board_sd || '')
    let boardOffice: string | null = null
    if (boardId && activeBoardOC && boardId === activeBoardOC) boardOffice = 'Orange County'
    else if (boardId && activeBoardSD && boardId === activeBoardSD) boardOffice = 'San Diego'

    // Leads-generated stream: new items on the static Incoming Leads board
    // count as production ("Submitted"); results keep coming from the Block
    // boards. Column changes on the leads board are deliberately ignored.
    const incomingLeadsBoardId = String((settingsRow as any)?.incoming_leads_board_id || '')
    let isIncomingLeadsBoard = !!incomingLeadsBoardId && boardId === incomingLeadsBoardId
    if (isIncomingLeadsBoard && (incomingLeadsBoardId === activeBoardOC || incomingLeadsBoardId === activeBoardSD)) {
      // Misconfiguration would silently swallow every Block outcome event.
      await supabaseAdmin.from('webhook_logs').insert({
        step: 'Config_Error',
        data: { message: 'incoming_leads_board_id equals an active Block board — treating as Block', incomingLeadsBoardId },
      })
      isIncomingLeadsBoard = false
    }

    await supabaseAdmin.from('webhook_logs').insert({
      step: '2b_Board_Resolved',
      data: { boardId, activeBoardOC, activeBoardSD, boardOffice, isIncomingLeadsBoard },
    })

    // Leads-board column changes: only the confirmation team's "Lead Status"
    // column feeds the dispatch funnel. Every other column change on the
    // 5,000+-item CRM board is dropped here, before any Monday API spend.
    const LEAD_STATUS_COL_ID = 'dup__of_sd_lead'
    const isLeadStatusEvent =
      isIncomingLeadsBoard && !isCreateEvent && changedColumnId === LEAD_STATUS_COL_ID
    if (isIncomingLeadsBoard && !isCreateEvent && !isLeadStatusEvent) {
      await supabaseAdmin.from('webhook_logs').insert({
        step: 'Ignored_Leads_Board_Other_Column',
        data: { pulseId: String(pulseId), boardId, changedColumnId: changedColumnId ?? null },
      })
      return new Response('Leads board non-Lead-Status ignored', { status: 200, headers: corsHeaders })
    }

    // Step 3: Fetch Monday token
    let mondayToken = (settingsRow as any)?.monday_api_token
      || (settingsRow as any)?.value
      || (settingsRow as any)?.setting_value
      || (settingsRow as any)?.config_value
      || null
    if (!mondayToken && settingsRow) {
      for (const [k, v] of Object.entries(settingsRow)) {
        if (typeof v === 'string' && v.length > 20 && k !== 'id' && !k.startsWith('active_monday_board')) {
          mondayToken = v; break
        }
      }
    }
    if (!mondayToken) {
      await supabaseAdmin.from('webhook_logs').insert({
        step: 'Error_No_Token',
        data: { keys: settingsRow ? Object.keys(settingsRow) : [] },
      })
      return new Response('No token', { status: 200, headers: corsHeaders })
    }
    mondayToken = String(mondayToken)

    // Step 3b: Query Monday GraphQL for the item. FormulaValue.display_value
    // covers formula-typed columns (e.g. a computed Sale Price), whose plain
    // text/value fields are always empty. The fetch is coalesced with other
    // concurrent deliveries into one items(ids: [...]) query and retried on
    // rate/complexity errors — see monday.ts. Ids are interpolated into the
    // GraphQL document, so reject non-numeric pulseIds outright.
    const pulseIdStr = String(pulseId)
    if (!/^\d+$/.test(pulseIdStr)) {
      await supabaseAdmin.from('webhook_logs').insert({
        step: 'Error_Bad_PulseId',
        data: { pulseId: pulseIdStr },
      })
      return new Response('Bad pulseId', { status: 200, headers: corsHeaders })
    }
    const { item: mondayItem, error: mondayError } = await fetchItemBatched(mondayToken, pulseIdStr)

    await supabaseAdmin.from('webhook_logs').insert({
      step: '3_Monday_API_Response',
      data: { pulseId, mondayError, hasItem: !!mondayItem },
    })

    if (!mondayItem) {
      await supabaseAdmin.from('webhook_logs').insert({
        step: 'Error_Monday_No_Item',
        data: { pulseId, mondayError },
      })
      // Transient failure (network / API error / rate limit): return 5xx so
      // Monday's once-a-minute retry loop redelivers — the Event_Processed
      // marker is only written after success, so retries are not swallowed.
      // A clean response with no item = the item is gone; that's permanent.
      if (mondayError) {
        return new Response('Monday API error', { status: 502, headers: corsHeaders })
      }
      return new Response('No Monday item', { status: 200, headers: corsHeaders })
    }

    const item = mondayItem as any
    const cols: Array<{ id: string; text: string | null; column: { title: string; id: string } }> =
      item.column_values || []

    // Only cards BORN in the Inbound group are canvasser production. The
    // confirmers create new cards on this board when recycling old leads
    // (Futures / Never Confirmed / Reschedules / QR / Internet …) — those must
    // never credit, and must never mint Bouncer placeholder profiles either,
    // so this gate sits before any name matching. Creates only: Lead Status
    // flips credit any card with a matching Agent (owner decision 2026-07-24;
    // cards leave Inbound long before confirmation).
    if (isIncomingLeadsBoard && isCreateEvent) {
      const groupId = String(item.group?.id ?? '')
      const groupTitle = String(item.group?.title ?? '')
      const isInbound = groupId === 'topics' || groupTitle.trim().toLowerCase() === 'inbound'
      if (!isInbound) {
        await supabaseAdmin.from('webhook_logs').insert({
          step: 'Ignored_Leads_Board_Non_Inbound',
          data: { pulseId: String(pulseId), itemName: item.name, group: groupTitle || groupId },
        })
        return new Response('Non-Inbound leads-board card ignored', { status: 200, headers: corsHeaders })
      }
    }

    // Agent name column. The Incoming Leads board's Agent column id is stable
    // (text5); prefer it by id there so a stray "…agent…" title can't win.
    const nameCol =
      (isIncomingLeadsBoard ? cols.find((c) => c.id === 'text5' || c.column?.id === 'text5') : undefined) ??
      cols.find((c) => {
        const t = (c.column?.title || '').toLowerCase()
        return t === 'agent' || t.includes('agent') || t.includes('canvasser')
      })
    let canvasserName = (nameCol?.text || '').trim()

    // A blank Agent is BY DESIGN on channel cards (owner, 2026-08-10): the
    // Source column names the channel instead ("self gen" etc.), and the
    // matching lead-source profile takes the credit — never a person.
    if (!canvasserName) {
      const sourceCol =
        cols.find((c) => c.id === 'text' || c.column?.id === 'text') ??
        cols.find((c) => (c.column?.title || '').trim().toLowerCase() === 'source')
      const sourceText = (sourceCol?.text || '').trim().toLowerCase().replace(/\s+/g, ' ')
      const SOURCE_FALLBACKS: Record<string, string> = {
        'self gen': 'Self Gen',
        'selfgen': 'Self Gen',
        'job walk': 'Job Walk',
        'reload': 'Reload',
        'upsell': 'Upsell',
        // Rehash is Cynthia's channel (the confirmer) — owner, 2026-08-10.
        'rehash': 'Rehash / Cynthia King',
        'rehash / cynthia king': 'Rehash / Cynthia King',
      }
      const fallback = SOURCE_FALLBACKS[sourceText]
      if (fallback) {
        canvasserName = fallback
        await supabaseAdmin.from('webhook_logs').insert({
          step: 'Agent_From_Source',
          data: { pulseId: String(pulseId), source: sourceText, creditedAs: fallback },
        })
      }
    }

    // Incoming Leads items carry their own Office status column — use it so
    // credits and Bouncer-provisioned profiles land in the right office.
    if (isIncomingLeadsBoard) {
      const officeCol =
        cols.find((c) => c.id === 'color_mm2yzxqs' || c.column?.id === 'color_mm2yzxqs') ??
        cols.find((c) => (c.column?.title || '').trim().toLowerCase() === 'office')
      const officeText = (officeCol?.text || '').toLowerCase()
      if (/orange|\boc\b/.test(officeText)) boardOffice = 'Orange County'
      else if (/san diego|\bsd\b/.test(officeText)) boardOffice = 'San Diego'
    }

    // Locate the changed column
    const changedCol = changedColumnId
      ? cols.find((c) => (c.id === changedColumnId) || (c.column?.id === changedColumnId))
      : undefined
    const changedTitle = changedCol?.column?.title || ''
    const changedValue = (statusFromEvent || changedCol?.text || '').trim()

    await supabaseAdmin.from('webhook_logs').insert({
      step: '3b_Item_Inspect',
      data: { itemName: item.name, canvasserName, changedTitle, changedValue },
    })

    // ── Close Kombat snapshot ── mirror every Block-board card into
    // block_cards (sales-rep stats, Monday's own column language). Sits
    // BEFORE the "(copy)" skip and the no-canvasser-name skip below on
    // purpose: recycled "(copy)" cards and rep-only cards are real
    // appointments for the rep who runs them, even though they never touch
    // canvasser counters. Full-state idempotent upsert — redeliveries,
    // outcome flips, and rep reassignments all self-heal. Never breaks the
    // counter pipeline.
    if (!isIncomingLeadsBoard && boardOffice) {
      try {
        const weekStart =
          parseBoardWeekStart(String(item.board?.name ?? '')) ?? mondayOfISO(todayLA())
        const cardRow = buildBlockCardRow(item, boardId, boardOffice, weekStart, todayLA())
        const { error: cardErr } = await supabaseAdmin
          .from('block_cards')
          .upsert(cardRow, { onConflict: 'monday_item_id' })
        await supabaseAdmin.from('webhook_logs').insert({
          step: cardErr ? 'Rep_Card_Snapshot_Error' : 'Rep_Card_Snapshot',
          data: {
            pulseId: String(pulseId),
            card_date: cardRow.card_date,
            reps: cardRow.reps,
            sale: cardRow.sale,
            error: cardErr?.message ?? null,
          },
        })
      } catch (snapErr) {
        try {
          await supabaseAdmin.from('webhook_logs').insert({
            step: 'Rep_Card_Snapshot_Error',
            data: {
              pulseId: String(pulseId),
              error: snapErr instanceof Error ? snapErr.message : String(snapErr),
            },
          })
        } catch (_) { /* the snapshot must never break the pipeline */ }
      }
    }

    // The card's CURRENT canvasser state, derived once from the re-fetched
    // column set — used by the copy gate below and the outcome diff further
    // down (dedicated columns only; Setter Report parity).
    const { bucket, nonCore, ol } = deriveCanvassState(cols)

    // ── Copy gate ── Duplicated Monday items ("Endy and Rebecca Kuo (copy)")
    // get fresh pulseIds, so the triggerUuid/pulseId dedupe can't catch them —
    // they double-credit sits/points (seen live 2026-07-21). But a blanket
    // name-based skip also drops real production (OC audit 2026-07-27..08-01):
    // cards ENTERED with a "(copy)" name that have no counted original, and
    // outcome flips that happen on the copy card instead of the original. So
    // the skip now requires a counted same-board sibling in the SAME state:
    //   - sibling card (same board, same base customer name) already recorded
    //     this exact state → true duplicate → skip;
    //   - sibling recorded a DIFFERENT state → the outcome moved on the copy —
    //     process it as a transition seeded from the sibling's markers;
    //   - no counted sibling → the copy IS the card — process it normally.
    // A copy card that already recorded its own outcome is never re-gated
    // (later events on it — e.g. Sale Price edits — must keep flowing).
    let siblingPulseIds: string[] = []
    let siblingOutcome: MarkerRow | null = null
    let siblingOl: MarkerRow | null = null
    if (isCopyName(item.name)) {
      const { data: ownMarkers } = await supabaseAdmin
        .from('webhook_logs')
        .select('id')
        .eq('step', 'Card_Outcome_Recorded')
        .eq('data->>pulseId', String(pulseId))
        .limit(1)
      const ownRecorded = (ownMarkers?.length ?? 0) > 0
      if (!ownRecorded && !boardId) {
        // Without a board there is no sibling scan — keep the legacy skip
        // rather than risk a double-credit we can't rule out.
        await supabaseAdmin.from('webhook_logs').insert({
          step: 'Ignored_Copy_Item',
          data: { pulseId, itemName: item.name, canvasserName, note: 'No boardId — sibling scan impossible, legacy skip' },
        })
        return new Response('Copy item ignored', { status: 200, headers: corsHeaders })
      }
      if (!ownRecorded) {
        const base = copyBaseName(item.name)
        if (base) {
          const { data: boardCards } = await supabaseAdmin
            .from('block_cards')
            .select('monday_item_id, lead_name')
            .eq('board_id', boardId)
          siblingPulseIds = (boardCards ?? [])
            .filter((c) =>
              String(c.monday_item_id) !== String(pulseId) &&
              copyBaseName(c.lead_name ?? '') === base)
            .map((c) => String(c.monday_item_id))
        }
        if (siblingPulseIds.length === 0 && base) {
          // The office copies-then-DELETES originals, and the next full sync
          // purges the deleted card from block_cards — but its outcome markers
          // survive. Without this fallback the surviving copy looks
          // sibling-less and re-records the family's outcome (seen live
          // 2026-08-07: Miguel Munoz's Denardo CTC counted on the original
          // Thu and again on the copy Fri). Two board generations of markers
          // bound the name match; older same-name families are new cards.
          const since = new Date(Date.now() - 14 * 86400000).toISOString()
          const [exact, copies] = await Promise.all([
            supabaseAdmin.from('webhook_logs').select('data')
              .eq('step', 'Card_Outcome_Recorded')
              .eq('data->>itemName', base)
              .gte('created_at', since)
              .order('created_at', { ascending: false }).limit(5),
            supabaseAdmin.from('webhook_logs').select('data')
              .eq('step', 'Card_Outcome_Recorded')
              .like('data->>itemName', `${base} (copy%`)
              .gte('created_at', since)
              .order('created_at', { ascending: false }).limit(5),
          ])
          const ghostIds = [...(exact.data ?? []), ...(copies.data ?? [])]
            .map((r) => String((r.data as { pulseId?: string } | null)?.pulseId ?? ''))
            .filter((sid) => sid && sid !== String(pulseId))
          siblingPulseIds = [...new Set(ghostIds)]
        }
        if (siblingPulseIds.length > 0) {
          const latestSiblingMarker = async (step: string): Promise<MarkerRow | null> => {
            const per = await Promise.all(siblingPulseIds.map((sid) =>
              supabaseAdmin.from('webhook_logs')
                .select('data, created_at')
                .eq('step', step)
                .eq('data->>pulseId', sid)
                .order('created_at', { ascending: false })
                .limit(1)))
            const rows = per.flatMap((r) => (r.data ?? []) as MarkerRow[])
            rows.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
            return rows[0] ?? null
          }
          ;[siblingOutcome, siblingOl] = await Promise.all([
            latestSiblingMarker('Card_Outcome_Recorded'),
            latestSiblingMarker('Card_OL_Recorded'),
          ])
        }
        const sibData = (siblingOutcome?.data ?? null) as { bucket?: string | null; nonCore?: boolean } | null
        const sibBucket = (sibData?.bucket ?? null) as ScheduleBucket
        const sibNonCore = !!sibBucket && !!sibData?.nonCore
        if (siblingOutcome && sibBucket === bucket && sibNonCore === nonCore) {
          // The duplicate still carries the family's MONEY: the office
          // copies-then-deletes cards, so a Sale Price entered on the copy
          // is the only copy of that number — returning without syncing it
          // left $34,736 invisible in the week of 8/3. Update (or create)
          // the family's one lead before skipping the counters.
          try {
            const salePriceCol = findSalePriceCol(cols)
            const salePrice = parseMoney(salePriceCol?.text || salePriceCol?.display_value || '')
            const saleCol = findSaleOutcomeCol(cols)
            const isSold = SOLD_VALUES.includes((saleCol?.text ?? '').trim().toLowerCase())
            if (isSold && salePrice !== null) {
              const family = [String(pulseId), ...siblingPulseIds]
              const { data: famLeads } = await supabaseAdmin
                .from('leads')
                .select('id, sale_amount, status, deny_reason')
                .in('monday_item_id', family)
              const lead =
                (famLeads ?? []).find((l) => l.status === 'confirmed') ??
                (famLeads ?? []).find((l) => l.deny_reason === REVERT_REASON) ??
                null
              if (lead && (lead.sale_amount !== salePrice || lead.status !== 'confirmed')) {
                const { error: upErr } = await supabaseAdmin
                  .from('leads')
                  .update({ sale_amount: salePrice, status: 'confirmed', deny_reason: null })
                  .eq('id', lead.id)
                await supabaseAdmin.from('webhook_logs').insert({
                  step: upErr ? 'Sale_Lead_Update_Error' : 'Sale_Lead_Updated',
                  data: {
                    pulseId: String(pulseId), leadId: lead.id, salePrice,
                    via: 'copy-gate family sync', error: upErr?.message ?? null,
                  },
                })
              } else if (!lead) {
                const sibCanvasser =
                  (siblingOutcome.data as { canvasser_id?: string } | null)?.canvasser_id ?? null
                if (sibCanvasser) {
                  const pinned = `${todayLA()}T20:00:00.000Z`
                  const { data: createdLead, error: leadErr } = await supabaseAdmin
                    .from('leads')
                    .insert({
                      canvasser_id: sibCanvasser,
                      team_id: null,
                      status: 'confirmed',
                      is_sale: true,
                      customer_name: item.name ?? null,
                      sale_amount: salePrice,
                      created_at: pinned,
                      reviewed_at: pinned,
                      notes: 'Monday live sale',
                      monday_item_id: String(pulseId),
                    })
                    .select('id')
                    .maybeSingle()
                  await supabaseAdmin.from('webhook_logs').insert({
                    step: leadErr ? 'Sale_Lead_Insert_Error' : 'Sale_Lead_Created',
                    data: {
                      pulseId: String(pulseId), leadId: createdLead?.id ?? null, salePrice,
                      canvasser_id: sibCanvasser, via: 'copy-gate family sync',
                      error: leadErr?.message ?? null,
                    },
                  })
                }
              }
            }
          } catch (_) { /* the family money sync must never break the gate */ }
          await supabaseAdmin.from('webhook_logs').insert({
            step: 'Ignored_Copy_Item',
            data: {
              pulseId, itemName: item.name, canvasserName, siblingPulseIds,
              bucket: bucket ?? null,
              note: 'Same-board sibling already recorded this state',
            },
          })
          return new Response('Copy item ignored', { status: 200, headers: corsHeaders })
        }
        await supabaseAdmin.from('webhook_logs').insert({
          step: 'Copy_Item_Credited',
          data: {
            pulseId, itemName: item.name, canvasserName, siblingPulseIds,
            siblingBucket: siblingOutcome ? sibBucket : null,
            note: siblingPulseIds.length === 0
              ? 'No same-board sibling card — the copy is the card'
              : siblingOutcome
                ? 'Sibling recorded a different state — processing as a transition'
                : 'Sibling cards exist but none recorded an outcome',
          },
        })
      }
    }

    if (!canvasserName) {
      await supabaseAdmin.from('webhook_logs').insert({
        step: 'Error_No_Canvasser_Name',
        data: { pulseId, columns: cols.map((c) => c.column?.title) },
      })
      return new Response('No canvasser', { status: 200, headers: corsHeaders })
    }

    // Step 4: Fuzzy match canvasser
    const wanted = normalizeName(canvasserName)
    const { data: profiles } = await supabaseAdmin
      .from('profiles')
      .select('id, display_name, office_location, team_id, suspension_tracked')

    const candidates = (profiles ?? [])
      .filter((p) => p.display_name)
      .map((p) => ({ ...p, _norm: normalizeName(p.display_name as string) }))

    // Incoming Leads board: EXACT normalized match only. Distinct people share
    // name fragments ("Ryan" in OC vs "Ian Ryan" in SD), and the substring
    // tiers below would credit one person's leads to another. No exact match
    // → the Bouncer provisions a separate profile, which is correct.
    let match = candidates.find((p) => p._norm === wanted)
    // A bare first name from the office ("Bobby") must not spawn a shadow
    // profile when exactly ONE profile carries that first name (owner,
    // 2026-08-10: Bobby's Friday lead credited a "Bobby" placeholder and
    // tripped the suspension list; six such shadows were merged by hand).
    // Ambiguous tokens (two Jonathans) still fall through to the Bouncer —
    // that provisioning stays the deliberate Incoming Leads behavior.
    if (!match && isIncomingLeadsBoard && !wanted.includes(' ')) {
      const byFirst = candidates.filter(
        (p) => p._norm !== wanted && p._norm.split(' ')[0] === wanted,
      )
      if (byFirst.length === 1) match = byFirst[0]
    }
    if (!match && !isIncomingLeadsBoard) {
      match = candidates.find((p) => p._norm.includes(wanted))
      if (!match) match = candidates.find((p) => wanted.includes(p._norm))
      if (!match) {
        const firstToken = wanted.split(' ')[0]
        if (firstToken) match = candidates.find((p) => p._norm.split(' ')[0] === firstToken)
      }
    }

    let autoCreated = false
    if (!match) {
      // The Bouncer: auto-provision a Free Agent placeholder profile so
      // no lead is ever dropped. Van assignment stays null until a Captain
      // drags them into a Van in Fleet Manager.
      const newId = crypto.randomUUID()
      const officeGuess = boardOffice ?? 'San Diego'
      const { data: created, error: createErr } = await supabaseAdmin
        .from('profiles')
        .insert({
          id: newId,
          display_name: canvasserName,
          office_location: officeGuess,
          is_placeholder: true,
          team_id: null,
        })
        .select('id, display_name, office_location, team_id, suspension_tracked')
        .single()
      if (createErr || !created) {
        await supabaseAdmin.from('webhook_logs').insert({
          step: 'Error_Auto_Create_Failed',
          data: { canvasserName, normalized: wanted, error: createErr?.message },
        })
        return new Response('Auto-create failed', { status: 200, headers: corsHeaders })
      }
      // Best-effort role grant (ignore duplicate/insert errors).
      await supabaseAdmin.from('user_roles').insert({ user_id: newId, role: 'canvasser' })
      match = { ...created, _norm: normalizeName(canvasserName) }
      autoCreated = true
      await supabaseAdmin.from('webhook_logs').insert({
        step: 'Auto_Created_Free_Agent',
        data: { canvasserName, newId, office: officeGuess },
      })
    }

    await supabaseAdmin.from('webhook_logs').insert({
      step: '4_Canvasser_Matched',
      data: { canvasserName, matchedId: match.id, matchedName: match.display_name, autoCreated },
    })

    // ── Van sync ── Monday's Van column is authoritative for van membership
    // (owner, 2026-07-28): every card names the rep's van, so each event
    // refreshes profiles.team_id. Real reps only — pseudo lead-sources
    // (suspension_tracked=false) never join vans. Unknown van names are
    // logged for the owner to add in Fleet, never auto-created.
    try {
      const vanCol =
        cols.find((c) => c.id === 'dropdown__1' || c.column?.id === 'dropdown__1') ??
        cols.find((c) => (c.column?.title || '').trim().toLowerCase() === 'van')
      const vanName = ((vanCol?.text || '').split(',')[0] || '').trim()
      if (vanName && match.suspension_tracked !== false) {
        const { data: teams } = await supabaseAdmin.from('teams').select('id, name')
        const team = (teams ?? []).find(
          (t) => (t.name || '').trim().toLowerCase() === vanName.toLowerCase(),
        )
        if (!team) {
          await supabaseAdmin.from('webhook_logs').insert({
            step: 'Van_Unknown',
            data: { pulseId: String(pulseId), vanName, canvasser: match.display_name },
          })
        } else if (match.team_id !== team.id) {
          const { error: vanErr } = await supabaseAdmin
            .from('profiles')
            .update({ team_id: team.id })
            .eq('id', match.id)
          if (!vanErr) {
            await supabaseAdmin.from('webhook_logs').insert({
              step: 'Van_Synced',
              data: { pulseId: String(pulseId), canvasser: match.display_name, vanName, from: match.team_id, to: team.id },
            })
            match.team_id = team.id
          }
        }
      }
    } catch (_) { /* van sync must never break the pipeline */ }

    // ── Lead Status funnel branch ── the confirmation team's flips of the
    // "Lead Status" column on the Incoming Leads board drive the Live Dispatch
    // funnel: Pending / Confirmed / Future / Blow-Out / N/A. Any card with an
    // exact-matching Agent credits, wherever it now sits on the board, and
    // Rep Reset cards count (owner decisions 2026-07-24). "Future Reconf" is
    // deliberately unmapped. Transition semantics mirror the Block path:
    // undo the previous bucket (floor 0), apply the new one. Never touches
    // daily_logs, leads_submitted, or the sale sync.
    if (isLeadStatusEvent) {
      const mapLeadStatus = (value: string | undefined): string | null => {
        const v = (value || '').trim().toLowerCase()
        if (!v) return null
        if (v === 'confirmed') return 'leads_confirmed'
        if (v === 'future') return 'future'
        if (v === 'blowout' || v === 'disconnected') return 'killed'
        if (v === 'unconfirmed' || v === 'room lead') return 'pending'
        if (v.startsWith('n/a')) return 'no_answers'
        return null
      }
      const statusBucket = mapLeadStatus(changedValue)
      const statusPrevBucket = mapLeadStatus(previousStatusFromEvent)
      if (statusBucket === statusPrevBucket) {
        await supabaseAdmin.from('webhook_logs').insert({
          step: 'Lead_Status_Noop',
          data: {
            pulseId: String(pulseId),
            from: previousStatusFromEvent ?? null,
            to: changedValue,
            note: statusBucket ? 'Same funnel bucket' : 'Neither value maps to a funnel bucket',
          },
        })
        return new Response('No-op (lead status)', { status: 200, headers: corsHeaders })
      }

      const statusDate = todayLA()
      const statusOffice = boardOffice ?? match.office_location ?? 'San Diego'
      const FUNNEL_KEYS = ['leads_confirmed', 'no_answers', 'killed', 'pending', 'future']

      const { data: statusRow } = await supabaseAdmin
        .from('daily_metrics')
        .select('id, leads_confirmed, no_answers, killed, pending, future')
        .eq('canvasser_id', match.id)
        .eq('metric_date', statusDate)
        .maybeSingle()
      const statusCur: Record<string, number> = statusRow ?? {
        leads_confirmed: 0, no_answers: 0, killed: 0, pending: 0, future: 0,
      }
      const statusNext: Record<string, number> = { ...statusCur }
      if (statusPrevBucket && FUNNEL_KEYS.includes(statusPrevBucket)) {
        statusNext[statusPrevBucket] = Math.max(0, (statusCur[statusPrevBucket] ?? 0) - 1)
      }
      if (statusBucket && FUNNEL_KEYS.includes(statusBucket)) {
        statusNext[statusBucket] = (statusNext[statusBucket] ?? 0) + 1
      }

      const { error: statusErr } = await supabaseAdmin
        .from('daily_metrics')
        .upsert({
          canvasser_id: match.id,
          metric_date: statusDate,
          office_location: statusOffice,
          leads_confirmed: statusNext.leads_confirmed ?? 0,
          no_answers: statusNext.no_answers ?? 0,
          killed: statusNext.killed ?? 0,
          pending: statusNext.pending ?? 0,
          future: statusNext.future ?? 0,
        }, { onConflict: 'canvasser_id,metric_date' })
      if (statusErr) {
        await supabaseAdmin.from('webhook_logs').insert({
          step: 'Lead_Status_Upsert_Error',
          data: { pulseId: String(pulseId), error: statusErr.message },
        })
        // 5xx so Monday's retry loop redelivers — Event_Processed is only
        // written after a successful counter write.
        return new Response('Lead status upsert failed', { status: 502, headers: corsHeaders })
      }

      if (triggerUuid) {
        await supabaseAdmin.from('webhook_logs').insert({
          step: 'Event_Processed',
          data: { triggerUuid, pulseId: String(pulseId) },
        })
      }
      await supabaseAdmin.from('webhook_logs').insert({
        step: 'Lead_Status_Processed',
        data: {
          pulseId: String(pulseId),
          agentName: match.display_name,
          canvasser_id: match.id,
          metric_date: statusDate,
          office: statusOffice,
          from: previousStatusFromEvent ?? null,
          to: changedValue,
          recordedAs: statusBucket,
          undid: statusPrevBucket,
        },
      })
      return new Response('Lead status recorded', { status: 200, headers: corsHeaders })
    }

    // ── Leads-generated branch ── a new item on the Incoming Leads board is
    // one unit of production for its Agent. Exactly once per item (claim-first
    // marker), atomic counter RPC (bursts of entries race read-modify-write).
    // Never touches the outcome path, daily_logs, or the sale sync.
    if (isIncomingLeadsBoard) {
      const pid = String(pulseId)
      const { data: genSeen } = await supabaseAdmin
        .from('webhook_logs').select('id')
        .eq('step', 'Lead_Generated_Credited').contains('data', { pulseId: pid }).limit(1)
      if ((genSeen?.length ?? 0) > 0) {
        await supabaseAdmin.from('webhook_logs').insert({
          step: 'Lead_Generated_Already_Credited',
          data: { pulseId: pid, canvasser_id: match.id },
        })
        return new Response('Already credited', { status: 200, headers: corsHeaders })
      }
      const { data: claim, error: genClaimErr } = await supabaseAdmin.from('webhook_logs').insert({
        step: 'Lead_Generated_Credited',
        data: { pulseId: pid, canvasser_id: match.id, itemName: item.name },
      }).select('id').single()
      if (genClaimErr) {
        // The partial unique index on this step (20260804 migration) makes
        // the insert itself the claim: 23505 = a concurrent delivery already
        // credited this item. Anything else is transient — 502 so Monday's
        // retry loop redelivers.
        const genCode = (genClaimErr as { code?: string }).code ?? null
        await supabaseAdmin.from('webhook_logs').insert({
          step: 'Lead_Generated_Claim_Rejected',
          data: { pulseId: pid, canvasser_id: match.id, code: genCode, error: genClaimErr.message },
        })
        if (genCode === '23505') {
          return new Response('Already credited', { status: 200, headers: corsHeaders })
        }
        return new Response('Claim insert failed', { status: 502, headers: corsHeaders })
      }

      const genDate = todayLA()
      const genOffice = boardOffice ?? match.office_location ?? 'San Diego'
      const { error: genErr } = await supabaseAdmin.rpc('increment_leads_generated', {
        _canvasser_id: match.id,
        _metric_date: genDate,
        _office: genOffice,
      })
      if (genErr) {
        // Release the claim so Monday's redelivery can credit successfully.
        if (claim?.id) await supabaseAdmin.from('webhook_logs').delete().eq('id', claim.id)
        await supabaseAdmin.from('webhook_logs').insert({
          step: 'Lead_Generated_Upsert_Error',
          data: { pulseId: pid, canvasser_id: match.id, error: genErr.message },
        })
        return new Response('Increment failed', { status: 502, headers: corsHeaders })
      }

      if (triggerUuid) {
        await supabaseAdmin.from('webhook_logs').insert({
          step: 'Event_Processed',
          data: { triggerUuid, pulseId: pid },
        })
      }
      await supabaseAdmin.from('webhook_logs').insert({
        step: 'Lead_Generated_Processed',
        data: { pulseId: pid, canvasser_id: match.id, metric_date: genDate, office: genOffice },
      })
      return new Response('Lead generated credited', { status: 200, headers: corsHeaders })
    }

    // Step 5: One card = one outcome. The card's CURRENT state (bucket /
    // nonCore / ol) was derived above the copy gate; diff it against the last
    // state recorded for this card (Card_Outcome_Recorded / Card_OL_Recorded
    // markers). Marks on any other column re-derive the same state and no-op.
    // A copy card with no history of its own inherits the counted state of
    // its same-board sibling (the card it was duplicated from), so outcome
    // flips on a copy apply as transitions instead of double-counts.
    const metric_date = todayLA()
    const office_location = boardOffice ?? match.office_location ?? 'San Diego'
    const [{ data: lastOutcomeRows }, { data: lastOlRows }] = await Promise.all([
      supabaseAdmin.from('webhook_logs').select('data, created_at')
        .eq('step', 'Card_Outcome_Recorded')
        .eq('data->>pulseId', String(pulseId))
        .order('created_at', { ascending: false }).limit(1),
      supabaseAdmin.from('webhook_logs').select('data, created_at')
        .eq('step', 'Card_OL_Recorded')
        .eq('data->>pulseId', String(pulseId))
        .order('created_at', { ascending: false }).limit(1),
    ])
    let ownOutcome: MarkerRow | null = (lastOutcomeRows?.[0] as MarkerRow | undefined) ?? null
    let ownOl: MarkerRow | null = (lastOlRows?.[0] as MarkerRow | undefined) ?? null
    // Previous state + the day/office it was counted on. Decrements must hit
    // THAT row, not today's — a next-day revert used to strand the original
    // +1 on the old day and burn a floored −1 on the new one (OC audit
    // 2026-07-27..08-01). New markers carry metric_date/office_location in
    // data; older ones date by created_at (written in the same breath as
    // their counters).
    let prevBucket: ScheduleBucket = null
    let prevNonCore = false
    let prevOl = false
    let prevOutcomeDate = metric_date
    let prevOutcomeOffice = office_location
    let prevOlDate = metric_date
    let prevOlOffice = office_location
    let outcomeChanged = false
    let olChanged = false
    const computeTransition = () => {
      const effOutcome = ownOutcome ?? siblingOutcome
      const effOl = ownOl ?? siblingOl
      const rec = (effOutcome?.data ?? {}) as {
        bucket?: string | null; nonCore?: boolean; metric_date?: string; office_location?: string
      }
      prevBucket = (rec.bucket as ScheduleBucket) ?? null
      prevNonCore = !!prevBucket && !!rec.nonCore
      prevOutcomeDate = rec.metric_date ?? laDateOf(effOutcome?.created_at) ?? metric_date
      prevOutcomeOffice = rec.office_location ?? office_location
      const olRec = (effOl?.data ?? {}) as { ol?: boolean; metric_date?: string; office_location?: string }
      prevOl = !!olRec.ol
      prevOlDate = olRec.metric_date ?? laDateOf(effOl?.created_at) ?? metric_date
      prevOlOffice = olRec.office_location ?? office_location
      outcomeChanged = bucket !== prevBucket || nonCore !== prevNonCore
      olChanged = ol !== prevOl
    }
    computeTransition()

    // ── New-lead credit ── exactly once per Monday item, whether the first
    // signal is the item's creation or its first mapped outcome change.
    // Claim-first via a webhook_logs marker; the legacy v2 marker
    // (Schedule_Outcome_Processed) still counts so pre-v3 items are not
    // re-credited, and a copy card shares its customer's credit with the
    // same-board cards it was duplicated from. The partial unique index on
    // Lead_Credit_Applied (20260804 migration) makes the insert itself the
    // claim — a 23505 means a concurrent delivery credited first. Credits:
    // daily_metrics.leads_submitted +1 and daily_logs.leads_called_in +1,
    // applied in the counter writes below.
    let creditMarkerId: string | null = null
    const applyLeadCredit = async (): Promise<boolean> => {
      const pid = String(pulseId)
      const family = [pid, ...siblingPulseIds]
      const seen = await Promise.all(family.flatMap((fid) => [
        supabaseAdmin.from('webhook_logs').select('id')
          .eq('step', 'Lead_Credit_Applied').eq('data->>pulseId', fid).limit(1),
        supabaseAdmin.from('webhook_logs').select('id')
          .eq('step', 'Schedule_Outcome_Processed').eq('data->>pulseId', fid).limit(1),
      ]))
      if (seen.some((r) => (r.data?.length ?? 0) > 0)) return false
      const { data: creditRow, error: creditErr } = await supabaseAdmin
        .from('webhook_logs')
        .insert({
          step: 'Lead_Credit_Applied',
          data: { pulseId: pid, canvasser_id: match.id, source: isCreateEvent ? 'create_item' : 'first_outcome' },
        })
        .select('id')
        .single()
      if (creditErr || !creditRow) {
        // 23505 = lost the once-ever claim to a concurrent delivery. Any
        // other failure also fails closed — a missed credit surfaces in
        // audits, a double credit silently inflates payroll.
        await supabaseAdmin.from('webhook_logs').insert({
          step: 'Lead_Credit_Claim_Rejected',
          data: { pulseId: pid, code: (creditErr as { code?: string } | null)?.code ?? null, error: creditErr?.message ?? null },
        })
        return false
      }
      creditMarkerId = creditRow.id
      return true
    }
    const creditNew = (isCreateEvent || bucket) ? await applyLeadCredit() : false

    // ── Sale Price → leads sync ─────────────────────────────────────────────
    // Payroll commission reads confirmed leads.sale_amount, so every sold item
    // must own exactly one leads row, keyed by monday_item_id (= pulseId).
    // The item's full column_values are re-fetched on every event, so ordering
    // self-heals: a price set before the Sale event rides in with it; a price
    // set after finds the existing lead and updates it in place.
    let isPriceEvent = false
    try {
      const salePriceCol = findSalePriceCol(cols)
      const salePriceRaw = salePriceCol?.text || salePriceCol?.display_value || ''
      const salePrice = parseMoney(salePriceRaw)
      const saleCol = findSaleOutcomeCol(cols)
      const itemIsSold = SOLD_VALUES.includes((saleCol?.text ?? '').trim().toLowerCase())
      isPriceEvent = !!changedColumnId && !!salePriceCol &&
        (changedColumnId === salePriceCol.id || changedColumnId === salePriceCol.column?.id)
      const mondayItemId = String(pulseId)

      if (bucket === 'sales' || prevBucket === 'sales' || isPriceEvent || itemIsSold) {
        await supabaseAdmin.from('webhook_logs').insert({
          step: 'Sale_Price_Inspect',
          data: {
            pulseId: mondayItemId, salePriceRaw, salePrice, itemIsSold, isPriceEvent,
            salePriceColTitle: salePriceCol?.column?.title ?? null,
            saleColText: saleCol?.text ?? null,
          },
        })
      }

      if (bucket === 'sales' || (isPriceEvent && itemIsSold)) {
        // Ensure the one lead for this Monday item exists and mirrors the
        // current price. Timestamps are pinned to ~noon PT of the business
        // date so the sale lands in the correct Mon–Sat pay week (the pay
        // engine casts to a UTC date).
        const pinned = `${metric_date}T20:00:00.000Z`
        const leadCols = 'id, sale_amount, status, deny_reason'
        const { data: existingLead } = await supabaseAdmin
          .from('leads')
          .select(leadCols)
          .eq('monday_item_id', mondayItemId)
          .maybeSingle()

        // Sync an existing lead to Monday's current state. created_at and
        // reviewed_at stay untouched so the pay week never shifts. A lead
        // denied by a human at the Confirmation Desk is never resurrected —
        // only our own automatic revert marker may be re-confirmed.
        type LeadRow = { id: string; sale_amount: number | null; status: string; deny_reason: string | null }
        const syncExistingLead = async (lead: LeadRow) => {
          if (lead.status === 'denied' && lead.deny_reason !== REVERT_REASON) {
            await supabaseAdmin.from('webhook_logs').insert({
              step: 'Sale_Lead_Denied_Skip',
              data: { pulseId: mondayItemId, leadId: lead.id, salePrice, deny_reason: lead.deny_reason },
            })
            return
          }
          if (lead.sale_amount === salePrice && lead.status === 'confirmed') return
          const { error: leadUpErr } = await supabaseAdmin
            .from('leads')
            .update({ sale_amount: salePrice, status: 'confirmed', deny_reason: null })
            .eq('id', lead.id)
          await supabaseAdmin.from('webhook_logs').insert({
            step: leadUpErr ? 'Sale_Lead_Update_Error' : 'Sale_Lead_Updated',
            data: {
              pulseId: mondayItemId, leadId: lead.id,
              from: { sale_amount: lead.sale_amount, status: lead.status },
              to: { sale_amount: salePrice, status: 'confirmed' },
              error: leadUpErr?.message ?? null,
            },
          })
        }

        if (!existingLead) {
          const { data: createdLead, error: leadErr } = await supabaseAdmin
            .from('leads')
            .insert({
              canvasser_id: match.id,
              team_id: match.team_id ?? null,
              status: 'confirmed',
              is_sale: true,
              customer_name: item.name ?? null,
              sale_amount: salePrice,
              created_at: pinned,
              reviewed_at: pinned,
              notes: 'Monday live sale',
              monday_item_id: mondayItemId,
            })
            .select('id')
            .maybeSingle()
          if (leadErr) {
            if ((leadErr as { code?: string }).code === '23505') {
              // Lost a concurrent-insert race: another request owns the lead
              // now — re-read it and sync so this event's price isn't lost.
              const { data: raced } = await supabaseAdmin
                .from('leads')
                .select(leadCols)
                .eq('monday_item_id', mondayItemId)
                .maybeSingle()
              if (raced) await syncExistingLead(raced as LeadRow)
            } else {
              await supabaseAdmin.from('webhook_logs').insert({
                step: 'Sale_Lead_Insert_Error',
                data: { pulseId: mondayItemId, code: (leadErr as { code?: string }).code ?? null, error: leadErr.message },
              })
            }
          } else {
            await supabaseAdmin.from('webhook_logs').insert({
              step: salePrice === null ? 'Sale_Missing_Price' : 'Sale_Lead_Created',
              data: { pulseId: mondayItemId, leadId: createdLead?.id ?? null, salePrice, canvasser_id: match.id },
            })
          }
        } else {
          await syncExistingLead(existingLead as LeadRow)
        }
      } else if (prevBucket === 'sales') {
        // Sale reverted in Monday (bucket is not 'sales' on this branch) →
        // drop the commission but keep the audit row.
        const { data: voided } = await supabaseAdmin
          .from('leads')
          .update({ status: 'denied', deny_reason: REVERT_REASON })
          .eq('monday_item_id', mondayItemId)
          .eq('status', 'confirmed')
          .select('id')
        if (voided && voided.length > 0) {
          await supabaseAdmin.from('webhook_logs').insert({
            step: 'Sale_Lead_Voided',
            data: { pulseId: mondayItemId, leadId: voided[0].id },
          })
        }
      } else if (isPriceEvent && !itemIsSold) {
        await supabaseAdmin.from('webhook_logs').insert({
          step: 'Sale_Price_Before_Sale_NoOp',
          data: { pulseId: mondayItemId, salePrice },
        })
      }
    } catch (syncErr) {
      // Lead sync must never break the counter pipeline.
      await supabaseAdmin.from('webhook_logs').insert({
        step: 'Sale_Lead_Sync_Error',
        data: { pulseId: String(pulseId), error: syncErr instanceof Error ? syncErr.message : String(syncErr) },
      })
    }

    // Price-only events carry no outcome change — never touch counters.
    if (isPriceEvent) {
      return new Response('Price event handled', { status: 200, headers: corsHeaders })
    }

    // Traffic cop: no state change and no new-lead credit → nothing to do.
    // This is where closer-side column marks (BO/RS/PM/Rep Stats) and other
    // edits land: the card re-derives to the state already recorded.
    if (!outcomeChanged && !olChanged && !creditNew) {
      if (!bucket && !prevBucket && !ol) {
        await supabaseAdmin.from('webhook_logs').insert({
          step: 'Ignored_Unmapped_Outcome',
          data: { boardId, boardOffice, changedTitle, changedValue, isCreateEvent },
        })
        return new Response('Ignored', { status: 200, headers: corsHeaders })
      }
      await supabaseAdmin.from('webhook_logs').insert({
        step: 'Same_Bucket_NoOp',
        data: {
          pulseId,
          agentName: match.display_name,
          bucket,
          nonCore,
          ol,
          changedColumn: changedTitle,
          newValue: changedValue,
          note: 'Card state unchanged; no counter mutation.',
        },
      })
      return new Response('No-op (same state)', { status: 200, headers: corsHeaders })
    }

    // Claim the state transitions BEFORE writing counters. The old claim was
    // read-then-insert across separate requests, so two same-second Monday
    // deliveries both passed the read and double-counted (seen live
    // 2026-07-29/30: one sale and one blowout each counted twice). The
    // claim_block_card_transition RPC (20260804 migration) re-verifies the
    // expected previous markers and inserts the new ones atomically under a
    // per-pulse advisory lock — all-or-nothing. Lost claim → adopt the actual
    // recorded state and re-diff once (a pure duplicate becomes a no-op, a
    // genuinely newer state re-claims); still contested → 502 so Monday's
    // retry loop redelivers against settled state. RPC not deployed yet →
    // legacy racy insert, flagged, so ingestion never stops.
    let outcomeMarkerId: string | null = null
    let olMarkerId: string | null = null
    const releaseCreditClaim = async () => {
      if (creditMarkerId) {
        await supabaseAdmin.from('webhook_logs').delete().eq('id', creditMarkerId)
        creditMarkerId = null
      }
    }
    const outcomeMarkerData = () => ({
      pulseId: String(pulseId), bucket, nonCore, prev: prevBucket,
      canvasser_id: match.id, metric_date, office_location,
      itemName: item.name ?? null,
      ...(ownOutcome == null && siblingOutcome != null ? { seededFromSiblings: siblingPulseIds } : {}),
    })
    const olMarkerData = () => ({
      pulseId: String(pulseId), ol, canvasser_id: match.id, metric_date, office_location,
    })
    if (outcomeChanged || olChanged) {
      const isMissingRpc = (e: { code?: string; message?: string }) =>
        e.code === 'PGRST202' || e.code === '42883' ||
        /could not find the function/i.test(e.message ?? '')
      let attempt = 0
      while (true) {
        attempt++
        const { data: claimData, error: claimErr } = await supabaseAdmin.rpc('claim_block_card_transition', {
          _pulse_id: String(pulseId),
          _claim_outcome: outcomeChanged,
          _expected_outcome: ownOutcome
            ? {
                exists: true,
                bucket: (ownOutcome.data as { bucket?: string | null } | null)?.bucket ?? null,
                nonCore: !!(ownOutcome.data as { nonCore?: boolean } | null)?.nonCore,
              }
            : { exists: false },
          _outcome_data: outcomeChanged ? outcomeMarkerData() : null,
          _claim_ol: olChanged,
          _expected_ol: ownOl
            ? { exists: true, ol: !!(ownOl.data as { ol?: boolean } | null)?.ol }
            : { exists: false },
          _ol_data: olChanged ? olMarkerData() : null,
        })
        if (claimErr) {
          if (isMissingRpc(claimErr)) {
            // Pre-migration fallback: the legacy inserts (racy — the gap
            // stays visible in the logs until the migration is applied).
            await supabaseAdmin.from('webhook_logs').insert({
              step: 'Claim_RPC_Missing',
              data: { pulseId: String(pulseId), note: 'Run 20260804010000_webhook_claim_gates.sql to close the double-count race' },
            })
            if (outcomeChanged) {
              const { data: legacyOutcome } = await supabaseAdmin.from('webhook_logs').insert({
                step: 'Card_Outcome_Recorded', data: outcomeMarkerData(),
              }).select('id').single()
              outcomeMarkerId = legacyOutcome?.id ?? null
            }
            if (olChanged) {
              const { data: legacyOl } = await supabaseAdmin.from('webhook_logs').insert({
                step: 'Card_OL_Recorded', data: olMarkerData(),
              }).select('id').single()
              olMarkerId = legacyOl?.id ?? null
            }
            break
          }
          await supabaseAdmin.from('webhook_logs').insert({
            step: 'Outcome_Claim_Error',
            data: { pulseId: String(pulseId), error: claimErr.message },
          })
          await releaseCreditClaim()
          // 5xx so Monday's retry loop redelivers — no counters were written.
          return new Response('Claim failed', { status: 502, headers: corsHeaders })
        }
        const res = (claimData ?? {}) as {
          claimed?: boolean
          outcome_marker_id?: string | null
          ol_marker_id?: string | null
          actual_outcome?: MarkerRow | null
          actual_ol?: MarkerRow | null
        }
        if (res.claimed) {
          outcomeMarkerId = res.outcome_marker_id ?? null
          olMarkerId = res.ol_marker_id ?? null
          break
        }
        // Lost to a concurrent delivery — adopt the actually-recorded own
        // state for the claims we asked about, then re-diff.
        if (outcomeChanged) ownOutcome = (res.actual_outcome as MarkerRow | null) ?? null
        if (olChanged) ownOl = (res.actual_ol as MarkerRow | null) ?? null
        computeTransition()
        if (!outcomeChanged && !olChanged) {
          await supabaseAdmin.from('webhook_logs').insert({
            step: 'Outcome_Claim_Superseded',
            data: {
              pulseId: String(pulseId), bucket: bucket ?? null, ol,
              note: 'A concurrent delivery already recorded this state.',
            },
          })
          if (!creditNew) {
            return new Response('No-op (state already recorded)', { status: 200, headers: corsHeaders })
          }
          break // still owe the new-lead credit counters below
        }
        if (attempt >= 2) {
          await supabaseAdmin.from('webhook_logs').insert({
            step: 'Outcome_Claim_Lost',
            data: { pulseId: String(pulseId), bucket: bucket ?? null, prev: prevBucket },
          })
          await releaseCreditClaim()
          // Contested twice — let Monday redeliver against settled state.
          return new Response('Claim contested', { status: 502, headers: corsHeaders })
        }
      }
    }

    // Funnel buckets (leads_confirmed / no_answers / killed / pending / future)
    // belong exclusively to the Incoming Leads board's Lead Status column —
    // Block events only move the Canvass Stats mirrors + outside_leads here.
    // Deltas are grouped per metric day: the undo half of a transition lands
    // on the day the previous state was counted, the new state (and the
    // new-lead credit) lands on today. One row per day, one atomic upsert.
    const metricDeltas = new Map<string, Record<string, number>>()
    const metricOffice = new Map<string, string>()
    const addMetricDelta = (date: string, office: string, col: string, d: number) => {
      const m = metricDeltas.get(date) ?? {}
      m[col] = (m[col] ?? 0) + d
      metricDeltas.set(date, m)
      if (!metricOffice.has(date)) metricOffice.set(date, office)
    }
    if (outcomeChanged) {
      const decC = prevBucket ? METRIC_COL[prevBucket] : undefined
      if (decC) addMetricDelta(prevOutcomeDate, prevOutcomeOffice, decC, -1)
      const incC = bucket ? METRIC_COL[bucket] : undefined
      if (incC) addMetricDelta(metric_date, office_location, incC, +1)
    }
    if (olChanged) {
      if (ol) addMetricDelta(metric_date, office_location, 'outside_leads', +1)
      else addMetricDelta(prevOlDate, prevOlOffice, 'outside_leads', -1)
    }
    if (creditNew) addMetricDelta(metric_date, office_location, 'leads_submitted', +1)

    if (metricDeltas.size > 0) {
      const rows: Record<string, unknown>[] = []
      for (const [date, deltas] of metricDeltas) {
        const { data: existing } = await supabaseAdmin
          .from('daily_metrics')
          .select('id, office_location, leads_submitted, blowouts, outside_leads, resets, pitch_missed, sales')
          .eq('canvasser_id', match.id)
          .eq('metric_date', date)
          .maybeSingle()
        const cur = (existing as Record<string, number | string | null> | null) ?? null
        const num = (k: string) => Number(cur?.[k] ?? 0)
        const next: Record<string, number> = {
          leads_submitted: num('leads_submitted'),
          blowouts: num('blowouts'),
          outside_leads: num('outside_leads'),
          resets: num('resets'),
          pitch_missed: num('pitch_missed'),
          sales: num('sales'),
        }
        for (const [col, d] of Object.entries(deltas)) {
          next[col] = Math.max(0, (next[col] ?? 0) + d)
        }
        rows.push({
          canvasser_id: match.id,
          metric_date: date,
          // Never re-home an existing day-row; only new rows take our guess.
          office_location: (cur?.office_location as string | null | undefined)
            ?? metricOffice.get(date) ?? office_location,
          ...next,
        })
      }
      const { error: upErr } = await supabaseAdmin
        .from('daily_metrics')
        .upsert(rows, { onConflict: 'canvasser_id,metric_date' })

      if (upErr) {
        // Release every claim so a later delivery can re-apply cleanly.
        if (outcomeMarkerId) {
          await supabaseAdmin.from('webhook_logs').delete().eq('id', outcomeMarkerId)
        }
        if (olMarkerId) {
          await supabaseAdmin.from('webhook_logs').delete().eq('id', olMarkerId)
        }
        await releaseCreditClaim()
        await supabaseAdmin.from('webhook_logs').insert({
          step: '5_Upsert_Error',
          data: { error: upErr.message },
        })
        return new Response('Upsert failed', { status: 200, headers: corsHeaders })
      }
    }

    // ── Payroll feed: mirror the outcome transition into daily_logs ─────────
    // calc_weekly_paycheck reads points/sits/activity from daily_logs, not
    // daily_metrics, so live Monday events must land there too. Same split as
    // the counters above: the undo half targets the (day, office) row the
    // previous state was counted on; the new state and the once-per-item
    // leads_called_in credit target today's board-office row. Floor at 0.
    try {
      const logDeltas = new Map<string, Record<string, number>>()
      const addLogVec = (date: string, office: string, vec: Record<string, number>, sign: number) => {
        const key = `${date}|${office}`
        const m = logDeltas.get(key) ?? {}
        for (const [k, v] of Object.entries(vec)) m[k] = (m[k] ?? 0) + sign * v
        logDeltas.set(key, m)
      }
      const bucketVec = (b: ScheduleBucket, nc: boolean): Record<string, number> => ({
        ...((b && DAILY_LOG_VECS[b]) || {}),
        ...(b && nc ? { non_core: 1 } : {}),
      })
      if (outcomeChanged) {
        addLogVec(prevOutcomeDate, prevOutcomeOffice, bucketVec(prevBucket, prevNonCore), -1)
        addLogVec(metric_date, office_location, bucketVec(bucket, nonCore), +1)
      }
      if (olChanged) {
        if (ol) addLogVec(metric_date, office_location, { one_legs: 1 }, +1)
        else addLogVec(prevOlDate, prevOlOffice, { one_legs: 1 }, -1)
      }
      // Credit "leads called in" once per Monday item — claimed above by
      // applyLeadCredit at creation or first mapped outcome, whichever first.
      if (creditNew) addLogVec(metric_date, office_location, { leads_called_in: 1 }, +1)

      for (const [key, delta] of logDeltas) {
        if (!Object.values(delta).some((v) => v !== 0)) continue
        const sep = key.indexOf('|')
        const log_date = key.slice(0, sep)
        const log_office = key.slice(sep + 1)
        // Ensure the row exists without clobbering fields on existing rows,
        // then read-modify-write only the counters we touch (legacy pattern).
        // Rows are per (canvasser, day, OFFICE) — the board's office — so a
        // rep working both blocks gets separate SD and OC rows.
        await supabaseAdmin.from('daily_logs').upsert(
          { canvasser_id: match.id, team_id: match.team_id ?? null, log_date, office_location: log_office },
          { onConflict: 'canvasser_id,log_date,office_location', ignoreDuplicates: true },
        )
        const { data: logRow, error: logReadErr } = await supabaseAdmin
          .from('daily_logs')
          .select('id, ' + DAILY_LOG_KEYS.join(', '))
          .eq('canvasser_id', match.id)
          .eq('log_date', log_date)
          .eq('office_location', log_office)
          .maybeSingle()
        if (logReadErr || !logRow) {
          await supabaseAdmin.from('webhook_logs').insert({
            step: 'Daily_Log_Feed_Error',
            data: { pulseId: String(pulseId), log_date, error: logReadErr?.message ?? 'daily_logs row missing after upsert' },
          })
          continue
        }
        const row = logRow as unknown as Record<string, unknown> & { id: string }
        const logUpdate: Record<string, number> = {}
        for (const [k, v] of Object.entries(delta)) {
          if (v !== 0) logUpdate[k] = Math.max(0, Number(row[k] ?? 0) + v)
        }
        const { error: logWriteErr } = await supabaseAdmin
          .from('daily_logs')
          .update(logUpdate as never)
          .eq('id', row.id)
        if (logWriteErr) {
          await supabaseAdmin.from('webhook_logs').insert({
            step: 'Daily_Log_Feed_Error',
            data: { pulseId: String(pulseId), log_date, error: logWriteErr.message },
          })
        }
      }
    } catch (feedErr) {
      // The payroll feed must never break the counter pipeline.
      await supabaseAdmin.from('webhook_logs').insert({
        step: 'Daily_Log_Feed_Error',
        data: { pulseId: String(pulseId), error: feedErr instanceof Error ? feedErr.message : String(feedErr) },
      })
    }

    // Mark this delivery processed BEFORE best-effort tail work: the counter
    // writes above are the retry-sensitive part, so the marker must cover
    // them even if rank refresh or the final log were to fail.
    if (triggerUuid) {
      await supabaseAdmin.from('webhook_logs').insert({
        step: 'Event_Processed',
        data: { triggerUuid, pulseId: String(pulseId), isCreateEvent },
      })
    }

    // Refresh rank + pay-lock evaluation for this canvasser (the old per-row
    // daily_logs trigger was dropped for bulk-import cost; write paths call
    // the engine explicitly instead). Best effort — never breaks the pipeline.
    try {
      await supabaseAdmin.rpc('refresh_canvasser_rank', { _canvasser_id: match.id })
    } catch (_) { /* rank refresh is best-effort */ }

    await supabaseAdmin.from('webhook_logs').insert({
      step: 'Schedule_Outcome_Processed',
      data: {
        pulseId: String(pulseId),
        boardId,
        boardOffice,
        agentName: match.display_name,
        canvasser_id: match.id,
        changedColumn: changedTitle,
        changedValue,
        previousValue: previousStatusFromEvent ?? null,
        previousBucket: prevBucket ?? null,
        previousMetricDate: outcomeChanged ? prevOutcomeDate : null,
        recordedAs: bucket ?? 'unmapped',
        nonCore,
        ol,
        metric_date,
      },
    })

    return new Response('Success', { headers: corsHeaders, status: 200 })
  } catch (err) {
    try {
      await supabaseAdmin.from('webhook_logs').insert({
        step: 'Fatal_Crash',
        data: { error: err instanceof Error ? err.message : String(err) },
      })
    } catch (_) { /* swallow */ }
    return new Response('Caught error', { headers: corsHeaders, status: 200 })
  }
})
