
-- ===== ENUMS =====
CREATE TYPE public.app_role AS ENUM ('owner', 'captain', 'canvasser');

-- ===== PROFILES =====
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  team_id UUID,
  level INT NOT NULL DEFAULT 1,
  xp INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- ===== USER ROLES =====
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role app_role NOT NULL,
  UNIQUE (user_id, role)
);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role app_role)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
$$;

-- ===== TEAMS =====
CREATE TABLE public.teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#22d3ee',
  captain_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.teams TO authenticated;
GRANT ALL ON public.teams TO service_role;
ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_team_fk FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE SET NULL;

-- ===== COMPANY SETTINGS (singleton) =====
CREATE TABLE public.company_settings (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE,
  company_name TEXT NOT NULL DEFAULT 'Your Company',
  global_visibility BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT company_settings_singleton CHECK (id)
);
GRANT SELECT, INSERT, UPDATE ON public.company_settings TO authenticated;
GRANT ALL ON public.company_settings TO service_role;
ALTER TABLE public.company_settings ENABLE ROW LEVEL SECURITY;

INSERT INTO public.company_settings (id) VALUES (TRUE);

-- ===== CANVASSER STATS =====
CREATE TABLE public.canvasser_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  period TEXT NOT NULL CHECK (period IN ('weekly', 'monthly', 'all_time')),
  period_start DATE NOT NULL,
  doors_knocked INT NOT NULL DEFAULT 0,
  contacts_made INT NOT NULL DEFAULT 0,
  sales_closed INT NOT NULL DEFAULT 0,
  revenue_generated NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, period, period_start)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.canvasser_stats TO authenticated;
GRANT ALL ON public.canvasser_stats TO service_role;
ALTER TABLE public.canvasser_stats ENABLE ROW LEVEL SECURITY;

-- ===== HELPER FUNCTIONS =====
CREATE OR REPLACE FUNCTION public.global_visibility_on()
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT COALESCE((SELECT global_visibility FROM public.company_settings WHERE id = TRUE), FALSE) $$;

CREATE OR REPLACE FUNCTION public.my_team_id(_user_id UUID)
RETURNS UUID LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT team_id FROM public.profiles WHERE id = _user_id $$;

-- ===== RLS POLICIES =====

-- profiles
CREATE POLICY "Owners see all profiles" ON public.profiles FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'owner'));
CREATE POLICY "Users see own profile" ON public.profiles FOR SELECT TO authenticated
  USING (id = auth.uid());
CREATE POLICY "Visibility: peers visible to canvassers/captains" ON public.profiles FOR SELECT TO authenticated
  USING (
    public.global_visibility_on()
    OR team_id = public.my_team_id(auth.uid())
  );
CREATE POLICY "Users update own profile" ON public.profiles FOR UPDATE TO authenticated
  USING (id = auth.uid());
CREATE POLICY "Owners manage profiles" ON public.profiles FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'owner')) WITH CHECK (public.has_role(auth.uid(), 'owner'));

-- user_roles
CREATE POLICY "Users see own roles" ON public.user_roles FOR SELECT TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY "Owners see all roles" ON public.user_roles FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'owner'));

-- teams
CREATE POLICY "Owners see all teams" ON public.teams FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'owner'));
CREATE POLICY "Members see own team" ON public.teams FOR SELECT TO authenticated
  USING (id = public.my_team_id(auth.uid()));
CREATE POLICY "Visibility: all teams visible when on" ON public.teams FOR SELECT TO authenticated
  USING (public.global_visibility_on());
CREATE POLICY "Owners manage teams" ON public.teams FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'owner')) WITH CHECK (public.has_role(auth.uid(), 'owner'));

-- company_settings
CREATE POLICY "Everyone reads company settings" ON public.company_settings FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY "Owners update company settings" ON public.company_settings FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'owner')) WITH CHECK (public.has_role(auth.uid(), 'owner'));

-- canvasser_stats
CREATE POLICY "Owners see all stats" ON public.canvasser_stats FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'owner'));
CREATE POLICY "Users see own stats" ON public.canvasser_stats FOR SELECT TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY "Visibility: peer stats" ON public.canvasser_stats FOR SELECT TO authenticated
  USING (
    public.global_visibility_on()
    OR (SELECT team_id FROM public.profiles WHERE id = user_id) = public.my_team_id(auth.uid())
  );
CREATE POLICY "Owners manage stats" ON public.canvasser_stats FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'owner')) WITH CHECK (public.has_role(auth.uid(), 'owner'));

-- ===== AUTO-CREATE PROFILE ON SIGNUP =====
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name, avatar_url)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'display_name', NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
    NEW.raw_user_meta_data->>'avatar_url'
  );
  -- Default new signups to canvasser; owner promotes later
  INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'canvasser');
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;
CREATE TRIGGER profiles_updated BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
