-- Read-only audit of the exported auth data (run on the LOCAL copy).
-- Informs how broker-era Google users will behave under native OAuth.

\echo '=== identities by provider ==='
SELECT i.provider,
       count(*) AS identities,
       count(*) FILTER (WHERE u.email_confirmed_at IS NULL) AS unconfirmed_users,
       count(*) FILTER (WHERE u.encrypted_password IS NULL OR u.encrypted_password = '') AS no_password
FROM auth.identities i
JOIN auth.users u ON u.id = i.user_id
GROUP BY i.provider
ORDER BY i.provider;

\echo '=== users with NO identity rows (broker-created accounts sometimes lack them) ==='
SELECT u.id, u.email,
       (u.encrypted_password IS NOT NULL AND u.encrypted_password <> '') AS has_password,
       u.email_confirmed_at IS NOT NULL AS confirmed
FROM auth.users u
WHERE NOT EXISTS (SELECT 1 FROM auth.identities i WHERE i.user_id = u.id)
ORDER BY u.created_at;

\echo '=== non-email identity payload sample (is provider_id the real Google sub?) ==='
SELECT provider, provider_id,
       identity_data->>'sub' AS sub,
       identity_data->>'email' AS email
FROM auth.identities
WHERE provider <> 'email'
LIMIT 20;

\echo '=== email-confirmation policy inference (autoconfirmed ≈ created within 5s) ==='
SELECT count(*) FILTER (WHERE email_confirmed_at IS NOT NULL
                          AND email_confirmed_at - created_at < interval '5 seconds') AS autoconfirmed,
       count(*) FILTER (WHERE email_confirmed_at IS NULL) AS never_confirmed,
       count(*) AS total
FROM auth.users;

\echo '=== things we assume are empty (must all be 0) ==='
SELECT 'storage.objects' AS what, count(*) FROM storage.objects
UNION ALL SELECT 'auth.mfa_factors', count(*) FROM auth.mfa_factors;

\echo '=== orphaned identities (fixed by 03) ==='
SELECT count(*) AS orphaned_identities
FROM auth.identities i
WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = i.user_id);
