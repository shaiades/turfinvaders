import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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

    const event = body?.data?.event || body?.event || body
    const pulseId = event?.pulseId || event?.itemId || event?.pulse_id
    const boardId = String(event?.boardId || event?.board_id || '')
    const changedColumnId: string | undefined = event?.columnId || event?.column_id
    const statusFromEvent: string | undefined =
      event?.value?.label?.text ||
      event?.value?.label ||
      event?.value?.text ||
      event?.columnValue?.label?.text

    await supabaseAdmin.from('webhook_logs').insert({
      step: '2_Payload_Parsed',
      data: { pulseId, boardId, changedColumnId, statusFromEvent },
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

    // Step 3b: Query Monday GraphQL for the item
    const query = `query { items(ids: [${pulseId}]) { id name board { id } column_values { id text column { title id } } } }`
    let mondayJson: any = null
    let mondayError: string | null = null
    try {
      const mondayResp = await fetch('https://api.monday.com/v2', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': mondayToken,
          'API-Version': '2024-01',
        },
        body: JSON.stringify({ query }),
      })
      mondayJson = await mondayResp.json()
    } catch (e) {
      mondayError = e instanceof Error ? e.message : String(e)
    }

    await supabaseAdmin.from('webhook_logs').insert({
      step: '3_Monday_API_Response',
      data: { pulseId, mondayError, hasItem: !!mondayJson?.data?.items?.[0] },
    })

    if (!mondayJson?.data?.items?.[0]) {
      await supabaseAdmin.from('webhook_logs').insert({
        step: 'Error_Monday_No_Item',
        data: { pulseId, mondayJson },
      })
      return new Response('No Monday item', { status: 200, headers: corsHeaders })
    }

    const item = mondayJson.data.items[0]
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
      .select('id, display_name, office_location')

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

    if (!match) {
      await supabaseAdmin.from('webhook_logs').insert({
        step: 'Error_Canvasser_Unmatched',
        data: { canvasserName, normalized: wanted },
      })
      return new Response('No match', { status: 200, headers: corsHeaders })
    }

    await supabaseAdmin.from('webhook_logs').insert({
      step: '4_Canvasser_Matched',
      data: { canvasserName, matchedId: match.id, matchedName: match.display_name },
    })

    // Step 5: Map the outcome
    const bucket = mapScheduleOutcome(changedTitle, changedValue)
    const metric_date = todayLA()
    const office_location = boardOffice ?? match.office_location ?? 'San Diego'

    const { data: existing } = await supabaseAdmin
      .from('daily_metrics')
      .select('id, leads_submitted, leads_confirmed, no_answers, killed, pending, blowouts, outside_leads, resets, pitch_missed, sales')
      .eq('canvasser_id', match.id)
      .eq('metric_date', metric_date)
      .maybeSingle()

    const cur = existing ?? {
      leads_submitted: 0, leads_confirmed: 0, no_answers: 0, killed: 0, pending: 0,
      blowouts: 0, outside_leads: 0, resets: 0, pitch_missed: 0, sales: 0,
    }
    const inc = (key: string) => (bucket === key ? 1 : 0)

    const payload = {
      canvasser_id: match.id,
      metric_date,
      office_location,
      leads_submitted: cur.leads_submitted ?? 0,
      leads_confirmed: (cur.leads_confirmed ?? 0) + inc('leads_confirmed'),
      no_answers: (cur.no_answers ?? 0) + inc('no_answers'),
      killed: (cur.killed ?? 0) + inc('killed'),
      pending: (cur.pending ?? 0) + inc('pending'),
      blowouts: (cur.blowouts ?? 0) + inc('blowouts'),
      outside_leads: (cur.outside_leads ?? 0) + inc('outside_leads'),
      resets: (cur.resets ?? 0) + inc('resets'),
      pitch_missed: (cur.pitch_missed ?? 0) + inc('pitch_missed'),
      sales: (cur.sales ?? 0) + inc('sales'),
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

    await supabaseAdmin.from('webhook_logs').insert({
      step: 'Schedule_Outcome_Processed',
      data: {
        boardId,
        boardOffice,
        agentName: match.display_name,
        canvasser_id: match.id,
        changedColumn: changedTitle,
        changedValue,
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
