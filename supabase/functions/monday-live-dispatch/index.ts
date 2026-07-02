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

type Bucket = 'leads_confirmed' | 'no_answers' | 'killed' | 'pending' | null
function mapStatus(raw: string): Bucket {
  const s = raw.trim().toLowerCase().replace(/\s+/g, ' ')
  if (s === 'confirmed' || s === 'future reconf') return 'leads_confirmed'
  if (s.startsWith('n/a')) return 'no_answers'
  if (s === 'blowout' || s === 'disconnected') return 'killed'
  if (s === 'unconfirmed' || s === 'future' || s === 'room lead') return 'pending'
  if (s === 'submitted') return null
  return 'pending'
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
    const statusFromEvent: string | undefined =
      event?.value?.label?.text ||
      event?.value?.label ||
      event?.value?.text ||
      event?.columnValue?.label?.text

    await supabaseAdmin.from('webhook_logs').insert({
      step: '2_Payload_Parsed',
      data: { pulseId, statusFromEvent },
    })

    if (!pulseId) {
      await supabaseAdmin.from('webhook_logs').insert({ step: 'Error_No_PulseId', data: { event } })
      return new Response('No pulseId', { status: 200, headers: corsHeaders })
    }

    // Step 3: Fetch Monday token
    const { data: tokenRow, error: tokenErr } = await supabaseAdmin
      .from('system_settings')
      .select('value')
      .eq('key', 'monday_api_token')
      .maybeSingle()

    if (tokenErr || !tokenRow?.value) {
      await supabaseAdmin.from('webhook_logs').insert({
        step: 'Error_No_Token',
        data: { error: tokenErr?.message, hasRow: !!tokenRow },
      })
      return new Response('No token', { status: 200, headers: corsHeaders })
    }
    const mondayToken = String(tokenRow.value)

    // Step 3b: Query Monday GraphQL
    const query = `query { items(ids: [${pulseId}]) { id name column_values { id text column { title } } } }`
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
      data: { pulseId, mondayError, response: mondayJson },
    })

    if (!mondayJson?.data?.items?.[0]) {
      await supabaseAdmin.from('webhook_logs').insert({
        step: 'Error_Monday_No_Item',
        data: { pulseId, mondayJson },
      })
      return new Response('No Monday item', { status: 200, headers: corsHeaders })
    }

    const item = mondayJson.data.items[0]
    const cols: Array<{ id: string; text: string | null; column: { title: string } }> =
      item.column_values || []

    // Find canvasser: prefer "agent" or "canvasser" column title
    const nameCol = cols.find((c) => {
      const t = (c.column?.title || '').toLowerCase()
      return t.includes('agent') || t.includes('canvasser')
    })
    const canvasserName = (nameCol?.text || '').trim()

    // Find status label
    const statusCol = cols.find((c) => {
      const t = (c.column?.title || '').toLowerCase()
      return t === 'status' || t.includes('status')
    })
    const rawStatus = (statusFromEvent || statusCol?.text || '').trim()

    if (!canvasserName) {
      await supabaseAdmin.from('webhook_logs').insert({
        step: 'Error_No_Canvasser_Name',
        data: { pulseId, itemName: item.name, columns: cols.map((c) => c.column?.title) },
      })
      return new Response('No canvasser', { status: 200, headers: corsHeaders })
    }

    // Step 4: Match canvasser
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

    // Step 5: Upsert daily_metrics
    const bucket = mapStatus(rawStatus)
    const isSubmittedOnly = rawStatus.trim().toLowerCase() === 'submitted'
    const metric_date = todayLA()
    const office_location = match.office_location ?? 'San Diego'

    const { data: existing } = await supabaseAdmin
      .from('daily_metrics')
      .select('id, leads_submitted, leads_confirmed, no_answers, killed, pending')
      .eq('canvasser_id', match.id)
      .eq('metric_date', metric_date)
      .maybeSingle()

    const nextSubmitted = (existing?.leads_submitted ?? 0) + 1
    const nextConfirmed = (existing?.leads_confirmed ?? 0) + (bucket === 'leads_confirmed' ? 1 : 0)
    const nextNoAnswers = (existing?.no_answers ?? 0) + (bucket === 'no_answers' ? 1 : 0)
    const nextKilled = (existing?.killed ?? 0) + (bucket === 'killed' ? 1 : 0)
    const nextPending = (existing?.pending ?? 0) + (bucket === 'pending' && !isSubmittedOnly ? 1 : 0)

    const { error: upErr } = await supabaseAdmin
      .from('daily_metrics')
      .upsert(
        {
          canvasser_id: match.id,
          metric_date,
          office_location,
          leads_submitted: nextSubmitted,
          leads_confirmed: nextConfirmed,
          no_answers: nextNoAnswers,
          killed: nextKilled,
          pending: nextPending,
        },
        { onConflict: 'canvasser_id,metric_date' },
      )

    if (upErr) {
      await supabaseAdmin.from('webhook_logs').insert({
        step: '5_Upsert_Error',
        data: { error: upErr.message },
      })
      return new Response('Upsert failed', { status: 200, headers: corsHeaders })
    }

    await supabaseAdmin.from('webhook_logs').insert({
      step: '5_Metrics_Updated',
      data: {
        canvasser_id: match.id,
        metric_date,
        rawStatus,
        bucket: bucket ?? 'submitted_only',
        totals: { nextSubmitted, nextConfirmed, nextNoAnswers, nextKilled, nextPending },
      },
    })

    return new Response('Success', { headers: corsHeaders, status: 200 })
  } catch (err) {
    try {
      await supabaseAdmin.from('webhook_logs').insert({
        step: 'Fatal_Crash',
        data: { error: err instanceof Error ? err.message : String(err) },
      })
    } catch (_) {
      // swallow
    }
    return new Response('Caught error', { headers: corsHeaders, status: 200 })
  }
})
