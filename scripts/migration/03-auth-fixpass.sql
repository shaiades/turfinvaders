-- Idempotent auth fix passes. Run on the LOCAL copy before extract,
-- and re-run on the DESTINATION after import (belt and suspenders).

BEGIN;

-- (a) Every real user must be email-confirmed BEFORE Google sign-in is
-- enabled: GoTrue's automatic email-based identity linking only attaches a
-- new google identity to an existing user when that user's email is
-- verified; otherwise it creates a duplicate user with no profile/roles.
UPDATE auth.users
SET email_confirmed_at = COALESCE(email_confirmed_at, created_at)
WHERE deleted_at IS NULL;

-- (b) Password holders need a proper 'email' identity row (GoTrue expects one).
INSERT INTO auth.identities
  (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
SELECT gen_random_uuid(), u.id, u.id::text, 'email',
       jsonb_build_object('sub', u.id::text, 'email', u.email,
                          'email_verified', true, 'phone_verified', false),
       now(), now(), now()
FROM auth.users u
WHERE u.deleted_at IS NULL
  AND u.email IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM auth.identities i
                  WHERE i.user_id = u.id AND i.provider = 'email');

-- (c) GoTrue 500s on NULL token columns (it expects empty strings).
UPDATE auth.users SET
  confirmation_token         = COALESCE(confirmation_token, ''),
  recovery_token             = COALESCE(recovery_token, ''),
  email_change               = COALESCE(email_change, ''),
  email_change_token_new     = COALESCE(email_change_token_new, ''),
  email_change_token_current = COALESCE(email_change_token_current, ''),
  phone_change               = COALESCE(phone_change, ''),
  phone_change_token         = COALESCE(phone_change_token, ''),
  reauthentication_token     = COALESCE(reauthentication_token, '')
WHERE confirmation_token IS NULL OR recovery_token IS NULL
   OR email_change IS NULL OR email_change_token_new IS NULL
   OR email_change_token_current IS NULL OR phone_change IS NULL
   OR phone_change_token IS NULL OR reauthentication_token IS NULL;

-- (d) Identities must reference an existing user.
DELETE FROM auth.identities i
WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = i.user_id);

COMMIT;

\echo '=== post-fix state (orphans must be 0; unconfirmed must be 0 for live users) ==='
SELECT
  (SELECT count(*) FROM auth.identities i
   WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = i.user_id)) AS orphaned_identities,
  (SELECT count(*) FROM auth.users
   WHERE deleted_at IS NULL AND email_confirmed_at IS NULL) AS unconfirmed_live_users;
