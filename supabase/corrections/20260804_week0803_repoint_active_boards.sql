-- Week of 8/3/26: point the live pipeline at the boards the crews actually
-- use. The Monday 6am rotation searched for the zero-padded name "8/03/26",
-- missed the crews' hand-named "SD Block 8/3/26-8/8/26" / "OC Block 8/3/26 -
-- 8/8/26", and registered this week's webhooks on two empty template
-- duplicates (18424864385 / 18424864472) instead.
--
-- Run in the xogit (xogitpqeuwalerxygvjw) SQL editor. Guarded: only flips
-- while settings still point at the orphan duplicates, so a re-run — or a
-- run after the fixed rotation already adopted the right boards — changes
-- nothing.
--
-- NOT needed if the rotate-boards fix is merged first and the rotation cron
-- is re-run (it now finds the crews' boards by parsed date and does this
-- update itself, plus moves the webhooks). After either path, the daily
-- 13:30 UTC ?mode=check cron attaches the webhooks to the active boards —
-- or hit it manually to get tonight's events flowing:
--   curl -X POST "https://turfinvaders.com/api/internal/rotate-boards?mode=check" \
--     -H "Authorization: Bearer $CRON_SECRET"

UPDATE public.system_settings
SET active_monday_board_sd = '18424812198',  -- "SD Block 8/3/26-8/8/26"
    active_monday_board_oc = '18424812732'   -- "OC Block 8/3/26 - 8/8/26"
WHERE active_monday_board_sd = '18424864385'
  AND active_monday_board_oc = '18424864472';
