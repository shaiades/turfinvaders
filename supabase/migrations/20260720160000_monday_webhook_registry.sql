-- Monday.com API integration support:
--   * monday_webhooks: registry of API-registered webhooks
--     [{ board_id, webhook_id, event, url, registered_at }] so rotation can
--     deregister the prior week's hooks and the Settings UI can show status.
--   * monday_template_board_id: the structure-only template board that the
--     weekly rotation duplicates for the new SD/OC Block boards.

ALTER TABLE public.system_settings
  ADD COLUMN IF NOT EXISTS monday_webhooks jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS monday_template_board_id text;
