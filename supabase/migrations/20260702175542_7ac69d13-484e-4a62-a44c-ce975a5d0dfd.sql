-- Allow placeholder profiles (team members with no auth login yet)
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_id_fkey;
-- user_roles.user_id also FKs to auth.users; drop so placeholder profiles can hold a role
ALTER TABLE public.user_roles DROP CONSTRAINT IF EXISTS user_roles_user_id_fkey;

-- Flag placeholder rows so we know they have no auth login
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_placeholder boolean NOT NULL DEFAULT false;