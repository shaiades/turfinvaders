ALTER TABLE public.system_settings
  ADD COLUMN IF NOT EXISTS active_monday_board_oc TEXT,
  ADD COLUMN IF NOT EXISTS active_monday_board_sd TEXT;