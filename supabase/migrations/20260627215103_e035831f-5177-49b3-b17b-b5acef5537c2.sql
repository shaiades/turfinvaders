-- Update handle_new_user: first signup becomes owner
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _is_first boolean;
  _assigned_role app_role;
BEGIN
  INSERT INTO public.profiles (id, display_name, avatar_url)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'display_name', NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
    NEW.raw_user_meta_data->>'avatar_url'
  );

  SELECT NOT EXISTS (SELECT 1 FROM public.user_roles) INTO _is_first;
  IF _is_first THEN
    _assigned_role := 'owner';
  ELSE
    _assigned_role := 'canvasser';
  END IF;

  INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, _assigned_role);
  RETURN NEW;
END;
$function$;

-- Recreate trigger to be safe
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Allow owners to manage roles
DROP POLICY IF EXISTS "Owners manage roles" ON public.user_roles;
CREATE POLICY "Owners manage roles" ON public.user_roles
FOR ALL TO authenticated
USING (public.has_role(auth.uid(), 'owner'))
WITH CHECK (public.has_role(auth.uid(), 'owner'));

-- Allow users to read their own roles (in addition to existing policies)
DROP POLICY IF EXISTS "Users read own roles" ON public.user_roles;
CREATE POLICY "Users read own roles" ON public.user_roles
FOR SELECT TO authenticated
USING (user_id = auth.uid());

-- Allow owners to read all profiles & update team assignments (if not already)
DROP POLICY IF EXISTS "Owners manage all profiles" ON public.profiles;
CREATE POLICY "Owners manage all profiles" ON public.profiles
FOR ALL TO authenticated
USING (public.has_role(auth.uid(), 'owner'))
WITH CHECK (public.has_role(auth.uid(), 'owner'));