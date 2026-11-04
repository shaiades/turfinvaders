#!/bin/bash
# Recreate the Incoming Leads board's Lead Date webhook via the edge function's
# ensure_lead_date_webhook admin action (it registers with the function's own
# current MONDAY_WEBHOOK_SECRET). Tries each project API key until the
# function's digest check accepts one. Prints {"ok":true,...} on success.
set -euo pipefail
supabase --workdir /Users/shaiades/Developer/turfinvaders projects api-keys --project-ref xogitpqeuwalerxygvjw -o json | python3 -c "
import sys, json, urllib.request
keys = [k['api_key'] for k in json.load(sys.stdin) if k.get('api_key')]
url = 'https://xogitpqeuwalerxygvjw.supabase.co/functions/v1/monday-live-dispatch?apikey=sb_publishable_ivjX0mrVvSLM1DHfDTDVuw_qHUtGeS2'
for k in keys:
    req = urllib.request.Request(url, data=b'{\"adminAction\":\"ensure_lead_date_webhook\"}', headers={'x-admin-key': k, 'Content-Type': 'application/json'}, method='POST')
    try:
        print(urllib.request.urlopen(req).read().decode()); break
    except Exception as e:
        print('key rejected:', getattr(e, 'code', e))
else:
    sys.exit(1)
"
