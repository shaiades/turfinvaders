import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  // 1. INITIALIZE CLIENT FIRST
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const supabaseAdmin = createClient(supabaseUrl, supabaseKey)

  try {
    // 2. LOG HEARTBEAT
    await supabaseAdmin.from('webhook_logs').insert({ step: '0_Endpoint_Hit' })

    // 3. SAFELY PARSE TEXT
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

    const event = body?.data?.event || body?.event
    const pulseId = event?.pulseId

    await supabaseAdmin.from('webhook_logs').insert({ step: '2_Payload_Parsed', data: { pulseId } })

    return new Response('Success', { headers: corsHeaders, status: 200 })
  } catch (err) {
    // 4. GUARANTEED FATAL LOG
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
