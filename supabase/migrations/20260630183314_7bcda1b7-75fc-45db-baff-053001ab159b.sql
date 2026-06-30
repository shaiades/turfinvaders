
CREATE TABLE public.system_settings (
  id boolean PRIMARY KEY DEFAULT TRUE,
  monday_api_token text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT system_settings_singleton CHECK (id = TRUE)
);

GRANT SELECT, INSERT, UPDATE ON public.system_settings TO authenticated;
GRANT ALL ON public.system_settings TO service_role;

ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners can view system settings"
  ON public.system_settings FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'owner'));

CREATE POLICY "Owners can insert system settings"
  ON public.system_settings FOR INSERT
  TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'owner'));

CREATE POLICY "Owners can update system settings"
  ON public.system_settings FOR UPDATE
  TO authenticated
  USING (public.has_role(auth.uid(), 'owner'))
  WITH CHECK (public.has_role(auth.uid(), 'owner'));

CREATE TRIGGER system_settings_touch_updated_at
  BEFORE UPDATE ON public.system_settings
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

INSERT INTO public.system_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;
