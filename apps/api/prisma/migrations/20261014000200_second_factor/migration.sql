-- classification: expand
BEGIN;

-- Actions d'audit de l'application (R17). Les valeurs ne sont pas utilisées dans cette transaction.
ALTER TYPE app.audit_action ADD VALUE IF NOT EXISTS 'ADMIN_LOGIN';
ALTER TYPE app.audit_action ADD VALUE IF NOT EXISTS 'ADMIN_EMAIL_CHANGED';
ALTER TYPE app.audit_action ADD VALUE IF NOT EXISTS 'PASSWORD_RESET_COMPLETED';
ALTER TYPE app.audit_action ADD VALUE IF NOT EXISTS 'ADMIN_SECOND_FACTOR_BLOCKED';

-- L'ordre des valeurs est l'ordre des verrous : LOGIN avant RECOVERY (§ 2.1).
CREATE TYPE app.challenge_purpose AS ENUM ('LOGIN', 'RECOVERY', 'STEP_UP', 'EMAIL_CHANGE_OLD', 'EMAIL_CHANGE_NEW');
CREATE TYPE app.challenge_consumed_reason AS ENUM ('USED', 'EXPIRED', 'SUPERSEDED', 'LOCKED', 'SESSION_ENDED');

ALTER TABLE app.users ADD COLUMN second_factor_blocked_at timestamptz;
GRANT UPDATE (email, second_factor_blocked_at) ON app.users TO cp_app;

CREATE FUNCTION app.users_second_factor_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.second_factor_blocked_at IS DISTINCT FROM OLD.second_factor_blocked_at THEN
    IF NEW.second_factor_blocked_at IS NULL AND current_user <> 'cp_privileged' THEN
      RAISE EXCEPTION 'second factor block is lifted by a privileged role only' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.second_factor_blocked_at IS NOT NULL AND NEW.second_factor_blocked_at IS NOT NULL THEN
      RAISE EXCEPTION 'second factor block date is final' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.second_factor_blocked_at IS NOT NULL AND NEW.global_role <> 'ADMIN' THEN
      RAISE EXCEPTION 'only an administrator can be blocked' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.email::text IS DISTINCT FROM OLD.email::text AND OLD.global_role <> 'ADMIN' AND current_user <> 'cp_privileged' THEN
    RAISE EXCEPTION 'only an administrator email is changed by the application' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_second_factor_guard BEFORE UPDATE ON app.users
  FOR EACH ROW EXECUTE FUNCTION app.users_second_factor_guard();

ALTER TABLE app.sessions
  ADD COLUMN second_factor_at     timestamptz,
  ADD COLUMN second_factor_method text,
  ADD COLUMN step_up_at           timestamptz,
  ADD CONSTRAINT sessions_second_factor_pair CHECK (
    (second_factor_at IS NULL AND second_factor_method IS NULL)
    OR (second_factor_at IS NOT NULL AND second_factor_method IN ('EMAIL_CODE', 'RECOVERY_CODE'))
  );
GRANT UPDATE (step_up_at) ON app.sessions TO cp_app;

-- Défense en profondeur : aucune session d'administrateur sans second facteur (§ 3.3).
CREATE FUNCTION app.sessions_admin_second_factor() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.second_factor_at IS NULL AND EXISTS (SELECT 1 FROM app.users u WHERE u.id = NEW.user_id AND u.global_role = 'ADMIN') THEN
    RAISE EXCEPTION 'an administrator session requires a second factor' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sessions_admin_second_factor BEFORE INSERT ON app.sessions
  FOR EACH ROW EXECUTE FUNCTION app.sessions_admin_second_factor();

CREATE TABLE app.auth_challenges (
  id             uuid PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES app.users (id) ON DELETE RESTRICT,
  purpose        app.challenge_purpose NOT NULL,
  session_id     uuid REFERENCES app.sessions (id) ON DELETE RESTRICT,
  token_hash     bytea,
  code_hmac      bytea NOT NULL,
  pending_email  ext.citext,
  ip             inet,
  attempts       smallint NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at     timestamptz NOT NULL,
  consumed_at    timestamptz,
  consumed_reason app.challenge_consumed_reason,
  CONSTRAINT auth_challenges_attempts_range CHECK (attempts BETWEEN 0 AND 5),
  CONSTRAINT auth_challenges_hmac_len CHECK (octet_length(code_hmac) = 32),
  CONSTRAINT auth_challenges_token_len CHECK (token_hash IS NULL OR octet_length(token_hash) = 32),
  CONSTRAINT auth_challenges_consumed CHECK (
    (consumed_at IS NULL AND consumed_reason IS NULL)
    OR (consumed_at IS NOT NULL AND consumed_reason IS NOT NULL)
  ),
  -- R2 : quatre formes.
  CONSTRAINT auth_challenges_shape CHECK (
    (purpose = 'LOGIN' AND token_hash IS NOT NULL AND session_id IS NULL AND pending_email IS NULL)
    OR (purpose = 'RECOVERY' AND token_hash IS NULL AND session_id IS NULL AND pending_email IS NULL)
    OR (purpose = 'STEP_UP' AND token_hash IS NULL AND session_id IS NOT NULL AND pending_email IS NULL)
    OR (purpose IN ('EMAIL_CHANGE_OLD', 'EMAIL_CHANGE_NEW') AND token_hash IS NULL AND session_id IS NOT NULL AND pending_email IS NOT NULL)
  )
);
CREATE UNIQUE INDEX auth_challenges_active ON app.auth_challenges (user_id, purpose) WHERE consumed_at IS NULL;
CREATE UNIQUE INDEX auth_challenges_token_hash_key ON app.auth_challenges (token_hash) WHERE token_hash IS NOT NULL;
CREATE INDEX auth_challenges_user_created_idx ON app.auth_challenges (user_id, created_at);

CREATE FUNCTION app.auth_challenges_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE u record;
BEGIN
  SELECT global_role, status, second_factor_blocked_at INTO u FROM app.users WHERE id = NEW.user_id;
  IF NEW.purpose = 'RECOVERY' AND current_user <> 'cp_privileged' THEN
    RAISE EXCEPTION 'a recovery challenge is created by a privileged role only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF u.global_role IS DISTINCT FROM 'ADMIN' OR u.status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'challenges are reserved to active administrators' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.purpose <> 'RECOVERY' AND u.second_factor_blocked_at IS NOT NULL THEN
    RAISE EXCEPTION 'second factor blocked' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.purpose = 'EMAIL_CHANGE_NEW' AND NOT EXISTS (
    SELECT 1 FROM app.auth_challenges o
     WHERE o.user_id = NEW.user_id AND o.purpose = 'EMAIL_CHANGE_OLD' AND o.session_id = NEW.session_id
       AND o.pending_email::text = NEW.pending_email::text AND o.consumed_reason = 'USED'
       AND o.consumed_at > clock_timestamp() - interval '15 minutes') THEN
    RAISE EXCEPTION 'the old address must be verified first' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER auth_challenges_guard BEFORE INSERT ON app.auth_challenges
  FOR EACH ROW EXECUTE FUNCTION app.auth_challenges_guard();

CREATE FUNCTION app.auth_challenges_immutable() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a consumed challenge no longer changes' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'attempts never decrease' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER auth_challenges_immutable BEFORE UPDATE ON app.auth_challenges
  FOR EACH ROW EXECUTE FUNCTION app.auth_challenges_immutable();

GRANT SELECT ON app.auth_challenges TO cp_app;
GRANT INSERT (id, user_id, purpose, session_id, token_hash, code_hmac, pending_email, ip, expires_at) ON app.auth_challenges TO cp_app;
GRANT UPDATE (attempts, consumed_at, consumed_reason) ON app.auth_challenges TO cp_app;

CREATE TABLE app.second_factor_failures (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES app.users (id) ON DELETE RESTRICT,
  challenge_id uuid,
  purpose      app.challenge_purpose NOT NULL,
  occurred_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX second_factor_failures_user_idx ON app.second_factor_failures (user_id, occurred_at);
GRANT SELECT ON app.second_factor_failures TO cp_app;
GRANT INSERT (user_id, challenge_id, purpose) ON app.second_factor_failures TO cp_app;

CREATE TABLE app.password_reset_tokens (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES app.users (id) ON DELETE RESTRICT,
  token_hash  bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  CONSTRAINT password_reset_hash_len CHECK (octet_length(token_hash) = 32),
  CONSTRAINT password_reset_token_hash_key UNIQUE (token_hash)
);
CREATE UNIQUE INDEX password_reset_active ON app.password_reset_tokens (user_id) WHERE consumed_at IS NULL;
GRANT SELECT ON app.password_reset_tokens TO cp_app;
GRANT INSERT (id, user_id, token_hash, expires_at) ON app.password_reset_tokens TO cp_app;
GRANT UPDATE (consumed_at) ON app.password_reset_tokens TO cp_app;

ALTER TABLE app.rate_limit_buckets DROP CONSTRAINT rate_limit_key_shape;
ALTER TABLE app.rate_limit_buckets ADD CONSTRAINT rate_limit_key_shape CHECK (
  key ~ '^ip:[0-9a-f:.]{1,45}$'
  OR key ~ '^ip\+acct:[0-9a-f:.]{1,45}:[0-9a-f]{64}$'
  OR key ~ '^(otp-ip|otp-try-ip|forgot-ip):[0-9a-f:.]{1,45}$'
  OR key ~ '^forgot-acct:[0-9a-f]{64}$'
);

COMMIT;
