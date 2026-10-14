-- classification: expand
BEGIN;

CREATE TYPE app.global_role AS ENUM ('USER', 'ADMIN');
CREATE TYPE app.user_status AS ENUM ('ACTIVE', 'SUSPENDED', 'DELETED');
CREATE TYPE app.session_revoke_reason AS ENUM
  ('LOGOUT', 'PASSWORD_CHANGED', 'ROLE_CHANGED', 'SUSPENDED', 'ANONYMIZED', 'EMAIL_CHANGED', 'ADMIN_REVOKED', 'OTHER_DEVICES', 'RESTORE');

CREATE TABLE app.users (
  id                     uuid PRIMARY KEY,
  email                  ext.citext,
  first_name             text,
  last_name              text,
  password_hash          text,
  global_role            app.global_role NOT NULL DEFAULT 'USER',
  status                 app.user_status NOT NULL DEFAULT 'ACTIVE',
  email_flagged_at       timestamptz,
  email_reminders        boolean NOT NULL DEFAULT true,
  email_announcements    boolean NOT NULL DEFAULT true,
  unsubscribe_token_hash bytea,
  deleted_at             timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_key UNIQUE (email),
  -- Forme normalisée (normalizeEmail) et ASCII imprimable uniquement (§ 2.1).
  CONSTRAINT users_email_normalized CHECK (
    email IS NULL
    OR (email::text = lower(normalize(btrim(email::text), NFKC))
        AND email::text ~ '^[!-~]+@[!-~]+$'
        AND length(email::text) <= 254)
  ),
  CONSTRAINT users_names_length CHECK (
    (first_name IS NULL OR char_length(first_name) BETWEEN 2 AND 80)
    AND (last_name IS NULL OR char_length(last_name) BETWEEN 2 AND 80)
  ),
  CONSTRAINT users_lifecycle CHECK (
    (status IN ('ACTIVE', 'SUSPENDED')
      AND email IS NOT NULL AND first_name IS NOT NULL AND last_name IS NOT NULL
      AND password_hash IS NOT NULL AND deleted_at IS NULL)
    OR
    (status = 'DELETED' AND global_role = 'USER'
      AND email IS NULL AND first_name IS NULL AND last_name IS NULL AND password_hash IS NULL
      AND email_flagged_at IS NULL AND unsubscribe_token_hash IS NULL
      AND email_reminders = false AND email_announcements = false
      AND deleted_at IS NOT NULL)
  )
);

GRANT SELECT ON app.users TO cp_app;
GRANT INSERT (id, email, first_name, last_name, password_hash, global_role, status, created_at, updated_at) ON app.users TO cp_app;
-- Au lot 1a, cp_app ne modifie que le nom, le hachage du mot de passe et les préférences.
GRANT UPDATE (first_name, last_name, password_hash, email_reminders, email_announcements, updated_at) ON app.users TO cp_app;

CREATE TABLE app.sessions (
  id                  uuid PRIMARY KEY,
  token_hash          bytea NOT NULL,
  user_id             uuid NOT NULL REFERENCES app.users (id) ON DELETE RESTRICT,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  idle_expires_at     timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  reauth_at           timestamptz,
  ip                  inet,
  user_agent          text,
  revoked_at          timestamptz,
  revoke_reason       app.session_revoke_reason,
  CONSTRAINT sessions_token_hash_key UNIQUE (token_hash),
  CONSTRAINT sessions_token_hash_len CHECK (octet_length(token_hash) = 32),
  CONSTRAINT sessions_expiry_order CHECK (idle_expires_at <= absolute_expires_at),
  CONSTRAINT sessions_revocation CHECK (
    (revoked_at IS NULL AND revoke_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)
  ),
  CONSTRAINT sessions_user_agent_len CHECK (user_agent IS NULL OR char_length(user_agent) <= 512)
);
CREATE INDEX sessions_user_active_idx ON app.sessions (user_id) WHERE revoked_at IS NULL;

-- Une révocation est définitive : ni la date ni le motif ne changent ensuite.
CREATE FUNCTION app.sessions_revocation_final() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL
     AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoke_reason IS DISTINCT FROM OLD.revoke_reason) THEN
    RAISE EXCEPTION 'session revocation is final' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sessions_revocation_final BEFORE UPDATE ON app.sessions
  FOR EACH ROW EXECUTE FUNCTION app.sessions_revocation_final();

GRANT SELECT, INSERT ON app.sessions TO cp_app;
GRANT UPDATE (last_seen_at, idle_expires_at, reauth_at, revoked_at, revoke_reason) ON app.sessions TO cp_app;

CREATE TABLE app.rate_limit_buckets (
  key             text PRIMARY KEY,
  window_start    timestamptz NOT NULL,
  attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  failures        integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  last_failure_at timestamptz,
  -- Clés bornées (§ 2.2) : IP ou préfixe /64, et HMAC-SHA256 hexadécimal de l'email normalisé.
  CONSTRAINT rate_limit_key_shape CHECK (
    key ~ '^ip:[0-9a-f:.]{1,45}$' OR key ~ '^ip\+acct:[0-9a-f:.]{1,45}:[0-9a-f]{64}$'
  )
);
GRANT SELECT, INSERT, UPDATE, DELETE ON app.rate_limit_buckets TO cp_app;

-- Une ligne unique qui sérialise les changements de rôle administrateur (§ 2.2).
CREATE TABLE app.role_guard (id smallint PRIMARY KEY CHECK (id = 1));
INSERT INTO app.role_guard (id) VALUES (1);
-- FOR UPDATE exige un droit UPDATE ; la colonne id ne peut de toute façon valoir que 1.
GRANT SELECT, UPDATE (id) ON app.role_guard TO cp_app;

COMMIT;
