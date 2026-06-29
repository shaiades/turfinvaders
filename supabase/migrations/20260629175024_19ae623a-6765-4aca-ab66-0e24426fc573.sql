
-- 1) Seed three Vans (only insert ones that don't already exist by name).
INSERT INTO public.teams (name, color)
SELECT v.name, v.color
FROM (VALUES
  ('Van 1', '#ff007a'),
  ('Van 2', '#00f0ff'),
  ('Van 3', '#a855f7')
) AS v(name, color)
WHERE NOT EXISTS (SELECT 1 FROM public.teams t WHERE t.name = v.name);

-- 2) Seed roster via auth.users; the on_auth_user_created trigger creates
--    the profile + default 'canvasser' role.
DO $$
DECLARE
  r RECORD;
  v_user_id uuid;
  v_team_id uuid;
  v_email text;
  v_slug text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- (display_name, van_name, is_captain)
      ('Eric',           'Van 1', TRUE),
      ('Jimmy',          'Van 1', FALSE),
      ('Ian',            'Van 1', FALSE),
      ('Lucas',          'Van 1', FALSE),
      ('Nate Hernandez', 'Van 1', FALSE),
      ('Mathew B',       'Van 1', FALSE),

      ('Bobby',          'Van 2', TRUE),
      ('Angelique',      'Van 2', FALSE),
      ('Marcel',         'Van 2', FALSE),
      ('Ricky Gomero',   'Van 2', FALSE),
      ('Matt C',         'Van 2', FALSE),
      ('Matt Riley',     'Van 2', FALSE),

      ('Miguel',         'Van 3', TRUE),
      ('Ethan David',    'Van 3', FALSE),
      ('Ernie',          'Van 3', FALSE),
      ('Josiah',         'Van 3', FALSE),
      ('Renat',          'Van 3', FALSE),
      ('Nolan',          'Van 3', FALSE)
    ) AS t(display_name, van_name, is_captain)
  LOOP
    v_slug  := regexp_replace(lower(r.display_name), '[^a-z0-9]+', '-', 'g');
    v_email := 'seed+' || v_slug || '@knockout.local';

    SELECT id INTO v_team_id FROM public.teams WHERE name = r.van_name LIMIT 1;

    -- Skip if this seed email already exists.
    SELECT id INTO v_user_id FROM auth.users WHERE email = v_email LIMIT 1;
    IF v_user_id IS NULL THEN
      v_user_id := gen_random_uuid();
      INSERT INTO auth.users (
        id, instance_id, aud, role, email, encrypted_password,
        email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
        created_at, updated_at, confirmation_token, recovery_token,
        email_change_token_new, email_change
      ) VALUES (
        v_user_id,
        '00000000-0000-0000-0000-000000000000',
        'authenticated',
        'authenticated',
        v_email,
        crypt(gen_random_uuid()::text, gen_salt('bf')),
        now(),
        jsonb_build_object('provider', 'seed', 'providers', ARRAY['seed']),
        jsonb_build_object('display_name', r.display_name, 'source', 'seed'),
        now(), now(), '', '', '', ''
      );
      -- The on_auth_user_created trigger has now created public.profiles
      -- and public.user_roles (default 'canvasser') for v_user_id.
    END IF;

    -- Assign to correct Van.
    UPDATE public.profiles
       SET team_id = v_team_id
     WHERE id = v_user_id;

    -- Captains: replace role with 'captain' and link the van.
    IF r.is_captain THEN
      DELETE FROM public.user_roles WHERE user_id = v_user_id;
      INSERT INTO public.user_roles (user_id, role) VALUES (v_user_id, 'captain');
      UPDATE public.teams SET captain_id = v_user_id WHERE id = v_team_id;
    END IF;
  END LOOP;
END $$;
