import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  let supabaseAdmin: ReturnType<typeof createClient> | undefined

  try {
    const body = await req.json()
    if (body.challenge) {
      return new Response(JSON.stringify({ challenge: body.challenge }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    const event = body?.data?.event || body?.event
    const pulseId = event?.pulseId

    await supabaseAdmin.from('webhook_logs').insert({
      step: '2.5_Reset_Successful',
      data: { pulseId },
    })

    const { data: settings, error: settingsError } = await supabaseAdmin
      .from('system_settings')
      .select('value')
      .eq('key', 'monday_api_token')
      .maybeSingle()

    if (settingsError || !settings?.value) {
      await supabaseAdmin.from('webhook_logs').insert({ step: 'Abort_No_Token' })
      return new Response('No token', { headers: corsHeaders, status: 200 })
    }

    await supabaseAdmin.from('webhook_logs').insert({ step: '3_Token_Found' })
    return new Response('Success', { headers: corsHeaders, status: 200 })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (supabaseAdmin) {
      await supabaseAdmin.from('webhook_logs').insert({
        step: 'Fatal_Crash',
        data: { error: message },
      })
    }
    return new Response('Caught error', { headers: corsHeaders, status: 200 })
  }
})
