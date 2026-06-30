
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS office_location text NOT NULL DEFAULT 'San Diego';
ALTER TABLE public.teams    ADD COLUMN IF NOT EXISTS office_location text NOT NULL DEFAULT 'San Diego';
UPDATE public.profiles SET office_location = 'San Diego' WHERE office_location IS NULL OR office_location = '';
UPDATE public.teams    SET office_location = 'San Diego' WHERE office_location IS NULL OR office_location = '';
CREATE INDEX IF NOT EXISTS profiles_office_location_idx ON public.profiles(office_location);
CREATE INDEX IF NOT EXISTS teams_office_location_idx    ON public.teams(office_location);
