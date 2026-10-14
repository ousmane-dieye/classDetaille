-- classification: expand
BEGIN;

CREATE TYPE app.email_kind AS ENUM (
  'WELCOME', 'REFUSAL', 'PASSWORD_RESET', 'DIGEST', 'ANNOUNCEMENT', 'ADMIN_ALERT', 'SECURITY_ALERT',
  'ADMIN_SECURITY_ALERT', 'ADMIN_OTP', 'ADMIN_EMAIL_CHANGE_OLD', 'ADMIN_EMAIL_CHANGE_NEW', 'TEST'
);
CREATE TYPE app.email_status AS ENUM ('PENDING', 'SENDING', 'RETRY_WAIT', 'UNCERTAIN', 'ACCEPTED', 'FAILED', 'EXPIRED', 'CANCELLED');
CREATE TYPE app.email_attempt_kind AS ENUM ('NORMAL', 'AMBIGUOUS_RETRY');
CREATE TYPE app.email_attempt_outcome AS ENUM ('ACCEPTED', 'TEMP_FAIL', 'PERM_FAIL', 'AMBIGUOUS', 'CANCELLED_IN_FLIGHT');

CREATE TABLE app.email_outbox (
  id                        uuid PRIMARY KEY,
  recipient_user_id         uuid REFERENCES app.users (id) ON DELETE RESTRICT,
  to_address                text NOT NULL,
  kind                      app.email_kind NOT NULL,
  dedupe_key                text NOT NULL,
  payload                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload_encrypted         bytea,
  message_id                text NOT NULL,
  status                    app.email_status NOT NULL DEFAULT 'PENDING',
  normal_attempts           smallint NOT NULL DEFAULT 0,
  ambiguous_retry_scheduled boolean NOT NULL DEFAULT false,
  ambiguous_retry_claimed   boolean NOT NULL DEFAULT false,
  next_attempt_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  locked_until              timestamptz,
  claim_token               uuid,
  expires_at                timestamptz NOT NULL,
  accepted_at               timestamptz,
  challenge_id              uuid REFERENCES app.auth_challenges (id) ON DELETE RESTRICT,
  created_at                timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT email_outbox_dedupe_key_key UNIQUE (dedupe_key),
  CONSTRAINT email_outbox_message_id_key UNIQUE (message_id),
  CONSTRAINT email_outbox_normal_attempts_range CHECK (normal_attempts BETWEEN 0 AND 5),
  CONSTRAINT email_outbox_claimed_scheduled CHECK (NOT ambiguous_retry_claimed OR ambiguous_retry_scheduled),
  CONSTRAINT email_outbox_payload_size CHECK (octet_length(payload::text) <= 4096),
  -- § 2.4 : chaque colonne est liée à l'état.
  CONSTRAINT email_outbox_state_shape CHECK (
    (status = 'PENDING' AND normal_attempts = 0 AND NOT ambiguous_retry_scheduled AND NOT ambiguous_retry_claimed
      AND claim_token IS NULL AND locked_until IS NULL AND accepted_at IS NULL)
    OR (status = 'SENDING' AND normal_attempts >= 1 AND claim_token IS NOT NULL AND locked_until IS NOT NULL AND accepted_at IS NULL)
    OR (status = 'RETRY_WAIT' AND normal_attempts BETWEEN 1 AND 4 AND NOT ambiguous_retry_scheduled AND NOT ambiguous_retry_claimed
      AND claim_token IS NULL AND locked_until IS NULL AND accepted_at IS NULL)
    OR (status = 'UNCERTAIN' AND normal_attempts BETWEEN 1 AND 5 AND ambiguous_retry_scheduled AND NOT ambiguous_retry_claimed
      AND claim_token IS NULL AND locked_until IS NULL AND accepted_at IS NULL)
    OR (status = 'ACCEPTED' AND accepted_at IS NOT NULL AND claim_token IS NULL AND locked_until IS NULL AND payload_encrypted IS NULL)
    OR (status IN ('FAILED', 'EXPIRED', 'CANCELLED') AND accepted_at IS NULL AND claim_token IS NULL AND locked_until IS NULL AND payload_encrypted IS NULL)
  ),
  -- Un type qui porte un secret a son contenu chiffré tant que l'email n'est pas final.
  CONSTRAINT email_outbox_secret_kinds CHECK (
    status IN ('ACCEPTED', 'FAILED', 'EXPIRED', 'CANCELLED')
    OR kind NOT IN ('PASSWORD_RESET', 'ADMIN_OTP', 'ADMIN_EMAIL_CHANGE_OLD', 'ADMIN_EMAIL_CHANGE_NEW')
    OR payload_encrypted IS NOT NULL
  ),
  -- challenge_email_link : un email de code est toujours lié à sa vérification, et seulement lui.
  CONSTRAINT email_outbox_challenge_link CHECK (
    (kind IN ('ADMIN_OTP', 'ADMIN_EMAIL_CHANGE_OLD', 'ADMIN_EMAIL_CHANGE_NEW') AND challenge_id IS NOT NULL)
    OR (kind NOT IN ('ADMIN_OTP', 'ADMIN_EMAIL_CHANGE_OLD', 'ADMIN_EMAIL_CHANGE_NEW') AND challenge_id IS NULL)
  )
);
-- one_email_per_challenge
CREATE UNIQUE INDEX one_email_per_challenge ON app.email_outbox (challenge_id) WHERE challenge_id IS NOT NULL;
CREATE INDEX email_outbox_due_idx ON app.email_outbox (next_attempt_at) WHERE status IN ('PENDING', 'RETRY_WAIT', 'UNCERTAIN');
CREATE INDEX email_outbox_sending_idx ON app.email_outbox (locked_until) WHERE status = 'SENDING';

CREATE FUNCTION app.email_outbox_transition() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.status IN ('ACCEPTED', 'FAILED', 'EXPIRED', 'CANCELLED') THEN
    RAISE EXCEPTION 'email in final state % no longer changes', OLD.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status IN ('PENDING', 'RETRY_WAIT', 'UNCERTAIN') AND NEW.status IN ('SENDING', 'EXPIRED', 'CANCELLED'))
    OR (OLD.status = 'SENDING' AND NEW.status IN ('ACCEPTED', 'RETRY_WAIT', 'UNCERTAIN', 'FAILED', 'CANCELLED'))
  ) THEN
    RAISE EXCEPTION 'email transition % -> % refused', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER email_outbox_transition BEFORE UPDATE ON app.email_outbox
  FOR EACH ROW EXECUTE FUNCTION app.email_outbox_transition();

-- outbox_challenge_guard : type, adresse, destinataire et expiration cohérents avec la vérification.
CREATE FUNCTION app.outbox_challenge_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE c record; expected_to text;
BEGIN
  IF NEW.challenge_id IS NULL THEN RETURN NEW; END IF;
  SELECT ch.user_id, ch.purpose, ch.pending_email, ch.expires_at, ch.consumed_at, u.email AS user_email
    INTO c FROM app.auth_challenges ch JOIN app.users u ON u.id = ch.user_id WHERE ch.id = NEW.challenge_id;
  IF NOT FOUND OR c.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'the challenge is not active' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT ((NEW.kind = 'ADMIN_OTP' AND c.purpose IN ('LOGIN', 'STEP_UP'))
       OR (NEW.kind = 'ADMIN_EMAIL_CHANGE_OLD' AND c.purpose = 'EMAIL_CHANGE_OLD')
       OR (NEW.kind = 'ADMIN_EMAIL_CHANGE_NEW' AND c.purpose = 'EMAIL_CHANGE_NEW')) THEN
    RAISE EXCEPTION 'email kind does not match the challenge purpose' USING ERRCODE = 'check_violation';
  END IF;
  expected_to := CASE WHEN c.purpose = 'EMAIL_CHANGE_NEW' THEN c.pending_email::text ELSE c.user_email::text END;
  IF NEW.to_address <> expected_to OR NEW.recipient_user_id IS DISTINCT FROM c.user_id THEN
    RAISE EXCEPTION 'address or recipient does not match the challenge' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.expires_at > c.expires_at THEN
    RAISE EXCEPTION 'email outlives its challenge' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER outbox_challenge_guard BEFORE INSERT ON app.email_outbox
  FOR EACH ROW EXECUTE FUNCTION app.outbox_challenge_guard();

CREATE FUNCTION app.email_outbox_notify() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM pg_notify('email_outbox', '');
  RETURN NULL;
END $$;
CREATE TRIGGER email_outbox_notify AFTER INSERT ON app.email_outbox
  FOR EACH STATEMENT EXECUTE FUNCTION app.email_outbox_notify();

CREATE TABLE app.email_attempts (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email_id      uuid NOT NULL REFERENCES app.email_outbox (id) ON DELETE RESTRICT,
  attempt_no    smallint NOT NULL,
  kind          app.email_attempt_kind NOT NULL,
  claim_token   uuid NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at   timestamptz,
  outcome       app.email_attempt_outcome,
  smtp_code     integer,
  smtp_response text,
  error_code    text,
  late_outcome  app.email_attempt_outcome,
  late_smtp_code integer,
  CONSTRAINT email_attempts_email_no_key UNIQUE (email_id, attempt_no),
  CONSTRAINT email_attempts_kind_no CHECK (
    (kind = 'NORMAL' AND attempt_no BETWEEN 1 AND 5)
    OR (kind = 'AMBIGUOUS_RETRY' AND attempt_no BETWEEN 2 AND 6)
  ),
  CONSTRAINT email_attempts_response_len CHECK (smtp_response IS NULL OR char_length(smtp_response) <= 500),
  CONSTRAINT email_attempts_late_only_cancelled CHECK (
    (late_outcome IS NULL AND late_smtp_code IS NULL)
    OR (outcome IS NOT NULL AND outcome = 'CANCELLED_IN_FLIGHT' AND late_outcome IS NOT NULL AND late_outcome <> 'CANCELLED_IN_FLIGHT')
  )
);
CREATE INDEX email_attempts_open_idx ON app.email_attempts (email_id, claim_token) WHERE outcome IS NULL;

CREATE FUNCTION app.email_attempts_once() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.outcome IS NOT NULL AND (
       NEW.outcome IS DISTINCT FROM OLD.outcome OR NEW.smtp_code IS DISTINCT FROM OLD.smtp_code
    OR NEW.smtp_response IS DISTINCT FROM OLD.smtp_response OR NEW.error_code IS DISTINCT FROM OLD.error_code
    OR NEW.finished_at IS DISTINCT FROM OLD.finished_at) THEN
    RAISE EXCEPTION 'an attempt result is written once' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.late_outcome IS NOT NULL AND (NEW.late_outcome IS DISTINCT FROM OLD.late_outcome OR NEW.late_smtp_code IS DISTINCT FROM OLD.late_smtp_code) THEN
    RAISE EXCEPTION 'a late result is written once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER email_attempts_once BEFORE UPDATE ON app.email_attempts
  FOR EACH ROW EXECUTE FUNCTION app.email_attempts_once();

-- challenge_consumed_cancels_emails : la consommation d'une vérification annule ses emails, y compris pendant l'envoi.
CREATE FUNCTION app.challenge_consumed_cancels_emails() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE app.email_attempts a SET outcome = 'CANCELLED_IN_FLIGHT', finished_at = clock_timestamp()
    FROM app.email_outbox o
   WHERE o.challenge_id = NEW.id AND o.status = 'SENDING' AND a.email_id = o.id AND a.outcome IS NULL;
  UPDATE app.email_outbox SET status = 'CANCELLED', claim_token = NULL, locked_until = NULL, payload_encrypted = NULL
   WHERE challenge_id = NEW.id AND status IN ('PENDING', 'SENDING', 'RETRY_WAIT', 'UNCERTAIN');
  RETURN NULL;
END $$;
CREATE TRIGGER challenge_consumed_cancels_emails AFTER UPDATE OF consumed_at ON app.auth_challenges
  FOR EACH ROW WHEN (OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL)
  EXECUTE FUNCTION app.challenge_consumed_cancels_emails();

CREATE TABLE app.job_leases (
  name          text PRIMARY KEY,
  holder        text,
  lease_until   timestamptz,
  fencing_token bigint NOT NULL DEFAULT 0
);
INSERT INTO app.job_leases (name) VALUES ('email.send'), ('maintenance.purge');

GRANT SELECT ON app.email_outbox TO cp_app;
GRANT INSERT (id, recipient_user_id, to_address, kind, dedupe_key, payload, payload_encrypted, message_id, expires_at, challenge_id)
  ON app.email_outbox TO cp_app;
GRANT UPDATE (status, normal_attempts, ambiguous_retry_scheduled, ambiguous_retry_claimed, next_attempt_at, locked_until, claim_token, accepted_at, payload_encrypted)
  ON app.email_outbox TO cp_app;
GRANT SELECT ON app.email_attempts TO cp_app;
GRANT INSERT (email_id, attempt_no, kind, claim_token) ON app.email_attempts TO cp_app;
GRANT UPDATE (finished_at, outcome, smtp_code, smtp_response, error_code, late_outcome, late_smtp_code) ON app.email_attempts TO cp_app;
GRANT SELECT ON app.job_leases TO cp_app;
GRANT UPDATE (holder, lease_until, fencing_token) ON app.job_leases TO cp_app;

COMMIT;
