import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { fetchItemBatched } from './monday.ts'

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

/**
 * Schedule board outcome mapper.
 * Returns which daily_metrics counter to bump based on the changed column
 * label and the new cell value. Match is case-insensitive.
 */
type ScheduleBucket =
  | 'blowouts'         // BO
  | 'outside_leads'    // OL
  | 'resets'           // RS
  | 'pitch_missed'     // PM
  | 'sales'            // SALE
  | 'leads_confirmed'  // Confirmed
  | 'no_answers'       // N/A
  | 'killed'           // Blowout/Disconnected (live-dispatch legacy)
  | 'pending'          // Unconfirmed/Future
  | null

function mapScheduleOutcome(columnTitle: string, value: string): ScheduleBucket {
  const col = (columnTitle || '').trim().toLowerCase()
  const v = (value || '').trim().toLowerCase()
  if (!v) return null

  // BO column
  if (col === 'bo' || col.includes('blowout')) {
    if (v === 'no show' || v === 'no demo' || v === 'bo') return 'blowouts'
  }
  // OL column
  if (col === 'ol' || col.includes('outside lead')) {
    if (v === 'ol' || v === 'outside lead') return 'outside_leads'
  }
  // RS column
  if (col === 'rs' || col.includes('reset')) {
    if (v === 'reset' || v === 'rs') return 'resets'
  }
  // PM column
  if (col === 'pm' || col.includes('pitch missed')) {
    if (v === 'pm' || v === 'pm w/ reset' || v === 'pm w reset' || v.startsWith('pm')) return 'pitch_missed'
  }
  // Sale column
  if (col === 'sale' || col.includes('sale')) {
    if (v === 'sold' || v === 'reload' || v === 'upsell' || v === 'sale') return 'sales'
  }

  // Fallback: value-based mapping (works even if column titles don't match).
  if (v === 'no show' || v === 'no demo') return 'blowouts'
  if (v === 'ol') return 'outside_leads'
  if (v === 'reset') return 'resets'
  if (v === 'pm' || v === 'pm w/ reset' || v === 'pm w reset') return 'pitch_missed'
  if (v === 'sold' || v === 'reload' || v === 'upsell') return 'sales'

  // Live-dispatch status column legacy mapping
  if (v === 'confirmed' || v === 'future reconf') return 'leads_confirmed'
  if (v.startsWith('n/a')) return 'no_answers'
  if (v === 'blowout' || v === 'disconnected') return 'killed'
  if (v === 'unconfirmed' || v === 'future' || v === 'room lead') return 'pending'
  return null
}

type MondayCol = { id: string; text: string | null; display_value?: string | null; column: { title: string; id: string } }

/** Sale-column values that mean the item is sold (mirrors mapScheduleOutcome). */
const SOLD_VALUES = ['sold', 'reload', 'upsell', 'sale']

/** deny_reason marker for leads voided by an automatic Monday sale revert.
 *  Only leads carrying this exact marker may be auto re-confirmed on a
 *  re-sale — human denials at the Confirmation Desk are never overridden. */
const REVERT_REASON = 'Monday sale status reverted'

/** Parse Monday money text ("$1,234.56") → number, else null. Rejects
 *  negatives and values beyond the leads.sale_amount numeric(12,2) range. */
function parseMoney(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.\-]/g, ''))
  if (!Number.isFinite(n) || n < 0 || n >= 1e10) return null
  return Math.round(n * 100) / 100
}

/** The "Sale Price" column: exact title first, never the outcome column "Sale". */
function findSalePriceCol(cols: MondayCol[]): MondayCol | undefined {
  const norm = (s: string | undefined) => (s || '').trim().toLowerCase()
  return (
    cols.find((c) => norm(c.column?.title) === 'sale price') ??
    cols.find((c) => norm(c.column?.title).replace(/\s+/g, '') === 'saleprice') ??
    cols.find((c) => norm(c.column?.title).includes('price'))
  )
}

/** The Sale outcome/status column (title "Sale", never "Sale Price"). */
function findSaleOutcomeCol(cols: MondayCol[]): MondayCol | undefined {
  const norm = (s: string | undefined) => (s || '').trim().toLowerCase()
  return (
    cols.find((c) => norm(c.column?.title) === 'sale') ??
    cols.find((c) => {
      const t = norm(c.column?.title)
      return t.includes('sale') && !t.includes('price')
    })
  )
}

/** Outcome-bucket → daily_logs counter deltas (payroll feed). Mirrors the
 *  legacy monday-webhook translation dictionary: BO/killed→no_demo,
 *  OL→one_legs, RS→future_leads, PM→demos_sits, Sale→demos_sits+sales,
 *  Confirmed→confirmed_leads. leads_called_in is handled separately
 *  (credited once per Monday item, not per status change). */
const DAILY_LOG_VECS: Record<string, Record<string, number>> = {
  blowouts: { no_demo: 1 },
  killed: { no_demo: 1 },
  outside_leads: { one_legs: 1 },
  resets: { future_leads: 1 },
  pitch_missed: { demos_sits: 1 },
  sales: { demos_sits: 1, sales: 1 },
  leads_confirmed: { confirmed_leads: 1 },
  no_answers: {},
  pending: {},
}

const DAILY_LOG_KEYS = [
  'no_demo', 'one_legs', 'future_leads', 'demos_sits', 'sales',
  'confirmed_leads', 'leads_called_in',
] as const

/** For item-creation events there is no "changed column" — derive the item's
 *  outcome from its full column set, highest-priority first (same precedence
 *  the CSV importer uses: Sale > PM > RS > BO > OL > the legacy statuses). */
function deriveBucketFromCols(cols: MondayCol[]): ScheduleBucket {
  const priority: ScheduleBucket[] = [
    'sales', 'pitch_missed', 'resets', 'blowouts', 'killed',
    'outside_leads', 'leads_confirmed', 'no_answers', 'pending',
  ]
  const found = new Set<ScheduleBucket>()
  for (const c of cols) {
    const b = mapScheduleOutcome(c.column?.title || '', c.text || '')
    if (b) found.add(b)
  }
  for (const p of priority) if (found.has(p)) return p
  return null
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

    await supabaseAdmin.from('webhook_logs').insert({
      step: '2b_Board_Resolved',
      data: { boardId, activeBoardOC, activeBoardSD, boardOffice },
    })

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

    // Agent name column
    const nameCol = cols.find((c) => {
      const t = (c.column?.title || '').toLowerCase()
      return t === 'agent' || t.includes('agent') || t.includes('canvasser')
    })
    const canvasserName = (nameCol?.text || '').trim()

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
      .select('id, display_name, office_location, team_id')

    const candidates = (profiles ?? [])
      .filter((p) => p.display_name)
      .map((p) => ({ ...p, _norm: normalizeName(p.display_name as string) }))

    let match = candidates.find((p) => p._norm === wanted)
    if (!match) match = candidates.find((p) => p._norm.includes(wanted))
    if (!match) match = candidates.find((p) => wanted.includes(p._norm))
    if (!match) {
      const firstToken = wanted.split(' ')[0]
      if (firstToken) match = candidates.find((p) => p._norm.split(' ')[0] === firstToken)
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
        .select('id, display_name, office_location, team_id')
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

    // Step 5: Map new + previous outcomes. Creation events have no changed
    // column — derive the outcome (if any) from the item's full column set.
    let bucket = mapScheduleOutcome(changedTitle, changedValue)
    let prevBucket = previousStatusFromEvent
      ? mapScheduleOutcome(changedTitle, previousStatusFromEvent)
      : null
    if (isCreateEvent) {
      bucket = deriveBucketFromCols(cols)
      prevBucket = null
    }
    const metric_date = todayLA()
    const office_location = boardOffice ?? match.office_location ?? 'San Diego'

    // ── New-lead credit ── exactly once per Monday item, whether the first
    // signal is the item's creation or its first mapped outcome change.
    // Claim-first via a webhook_logs marker; the legacy v2 marker
    // (Schedule_Outcome_Processed) still counts so pre-v3 items are not
    // re-credited. Credits: daily_metrics.leads_submitted +1 and
    // daily_logs.leads_called_in +1, applied in the counter writes below.
    const applyLeadCredit = async (): Promise<boolean> => {
      const pid = String(pulseId)
      const [creditSeen, legacySeen] = await Promise.all([
        supabaseAdmin.from('webhook_logs').select('id')
          .eq('step', 'Lead_Credit_Applied').contains('data', { pulseId: pid }).limit(1),
        supabaseAdmin.from('webhook_logs').select('id')
          .eq('step', 'Schedule_Outcome_Processed').contains('data', { pulseId: pid }).limit(1),
      ])
      if ((creditSeen.data?.length ?? 0) > 0 || (legacySeen.data?.length ?? 0) > 0) return false
      await supabaseAdmin.from('webhook_logs').insert({
        step: 'Lead_Credit_Applied',
        data: { pulseId: pid, canvasser_id: match.id, source: isCreateEvent ? 'create_item' : 'first_outcome' },
      })
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
      } else if (prevBucket === 'sales' && bucket !== 'sales') {
        // Sale reverted in Monday → drop the commission but keep the audit row.
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

    // Traffic cop: if we can't map this outcome AND there's no prev bucket to
    // decrement AND no new-lead credit to record, there's nothing to do.
    if (!bucket && !prevBucket && !creditNew) {
      await supabaseAdmin.from('webhook_logs').insert({
        step: 'Ignored_Unmapped_Outcome',
        data: { boardId, boardOffice, changedTitle, changedValue, isCreateEvent },
      })
      return new Response('Ignored', { status: 200, headers: corsHeaders })
    }

    // Same-bucket transition (e.g. "N/A" -> "N/A x2"): log + no-op.
    if (bucket && prevBucket && bucket === prevBucket) {
      await supabaseAdmin.from('webhook_logs').insert({
        step: 'Same_Bucket_NoOp',
        data: {
          pulseId,
          agentName: match.display_name,
          bucket,
          previousValue: previousStatusFromEvent,
          newValue: changedValue,
          note: 'Status changed within the same mapped bucket; no counter mutation.',
        },
      })
      return new Response('No-op (same bucket)', { status: 200, headers: corsHeaders })
    }

    const { data: existing } = await supabaseAdmin
      .from('daily_metrics')
      .select('id, leads_submitted, leads_confirmed, no_answers, killed, pending, blowouts, outside_leads, resets, pitch_missed, sales')
      .eq('canvasser_id', match.id)
      .eq('metric_date', metric_date)
      .maybeSingle()


    const cur: Record<string, number> = existing ?? {
      leads_submitted: 0, leads_confirmed: 0, no_answers: 0, killed: 0, pending: 0,
      blowouts: 0, outside_leads: 0, resets: 0, pitch_missed: 0, sales: 0,
    }

    const bucketKeys = [
      'leads_confirmed', 'no_answers', 'killed', 'pending',
      'blowouts', 'outside_leads', 'resets', 'pitch_missed', 'sales',
    ] as const

    const next: Record<string, number> = { ...cur }
    // Decrement previous bucket (floor at 0) when it's a real transition.
    if (prevBucket && bucketKeys.includes(prevBucket as any)) {
      next[prevBucket] = Math.max(0, (cur[prevBucket] ?? 0) - 1)
    }
    // Increment new bucket.
    if (bucket && bucketKeys.includes(bucket as any)) {
      next[bucket] = (next[bucket] ?? 0) + 1
    }

    const payload = {
      canvasser_id: match.id,
      metric_date,
      office_location,
      leads_submitted: (cur.leads_submitted ?? 0) + (creditNew ? 1 : 0),
      leads_confirmed: next.leads_confirmed ?? 0,
      no_answers: next.no_answers ?? 0,
      killed: next.killed ?? 0,
      pending: next.pending ?? 0,
      blowouts: next.blowouts ?? 0,
      outside_leads: next.outside_leads ?? 0,
      resets: next.resets ?? 0,
      pitch_missed: next.pitch_missed ?? 0,
      sales: next.sales ?? 0,
    }

    const { error: upErr } = await supabaseAdmin
      .from('daily_metrics')
      .upsert(payload, { onConflict: 'canvasser_id,metric_date' })

    if (upErr) {
      await supabaseAdmin.from('webhook_logs').insert({
        step: '5_Upsert_Error',
        data: { error: upErr.message },
      })
      return new Response('Upsert failed', { status: 200, headers: corsHeaders })
    }

    // ── Payroll feed: mirror the outcome transition into daily_logs ─────────
    // calc_weekly_paycheck reads points/sits/activity from daily_logs, not
    // daily_metrics, so live Monday events must land there too. Same transition
    // semantics as the counters above: undo the previous bucket, apply the new
    // one, floor at 0. leads_called_in is credited once per Monday item.
    try {
      const delta: Record<string, number> = {}
      for (const [k, v] of Object.entries((prevBucket && DAILY_LOG_VECS[prevBucket]) || {})) {
        delta[k] = (delta[k] ?? 0) - v
      }
      for (const [k, v] of Object.entries((bucket && DAILY_LOG_VECS[bucket]) || {})) {
        delta[k] = (delta[k] ?? 0) + v
      }
      // Credit "leads called in" once per Monday item — claimed above by
      // applyLeadCredit at creation or first mapped outcome, whichever first.
      if (creditNew) delta.leads_called_in = (delta.leads_called_in ?? 0) + 1

      if (Object.values(delta).some((v) => v !== 0)) {
        // Ensure the row exists without clobbering fields on existing rows,
        // then read-modify-write only the counters we touch (legacy pattern).
        await supabaseAdmin.from('daily_logs').upsert(
          { canvasser_id: match.id, team_id: match.team_id ?? null, log_date: metric_date },
          { onConflict: 'canvasser_id,log_date', ignoreDuplicates: true },
        )
        const { data: logRow, error: logReadErr } = await supabaseAdmin
          .from('daily_logs')
          .select('id, ' + DAILY_LOG_KEYS.join(', '))
          .eq('canvasser_id', match.id)
          .eq('log_date', metric_date)
          .maybeSingle()
        if (logReadErr || !logRow) {
          await supabaseAdmin.from('webhook_logs').insert({
            step: 'Daily_Log_Feed_Error',
            data: { pulseId: String(pulseId), error: logReadErr?.message ?? 'daily_logs row missing after upsert' },
          })
        } else {
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
              data: { pulseId: String(pulseId), error: logWriteErr.message },
            })
          }
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
        recordedAs: bucket ?? 'unmapped',
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
