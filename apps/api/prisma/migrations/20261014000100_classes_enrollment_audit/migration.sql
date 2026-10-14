-- classification: expand
BEGIN;

CREATE TYPE app.class_status AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TABLE app.classes (
  id            uuid PRIMARY KEY,
  name          text NOT NULL,
  level         text NOT NULL,
  academic_year text NOT NULL,
  status        app.class_status NOT NULL DEFAULT 'ACTIVE',
  archived_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT classes_name_year_key UNIQUE (name, academic_year),
  CONSTRAINT classes_archive_state CHECK (
    (status = 'ACTIVE' AND archived_at IS NULL) OR (status = 'ARCHIVED' AND archived_at IS NOT NULL)
  ),
  -- R8 : année « AAAA-AAAA », la seconde suivant la première.
  CONSTRAINT classes_text_lengths CHECK (
    char_length(name) BETWEEN 2 AND 80
    AND char_length(level) BETWEEN 1 AND 40
    AND CASE WHEN academic_year ~ '^[0-9]{4}-[0-9]{4}$'
             THEN substr(academic_year, 6, 4)::int = substr(academic_year, 1, 4)::int + 1
             ELSE false END
  )
);
GRANT SELECT ON app.classes TO cp_app;
GRANT INSERT (id, name, level, academic_year, created_at, updated_at) ON app.classes TO cp_app;
-- FOR SHARE exige un droit UPDATE sur au moins une colonne.
GRANT UPDATE (updated_at) ON app.classes TO cp_app;

CREATE TYPE app.enrollment_status AS ENUM ('PENDING', 'ACCEPTED', 'REFUSED');
CREATE TABLE app.enrollment_requests (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES app.users (id) ON DELETE RESTRICT,
  class_id      uuid NOT NULL REFERENCES app.classes (id) ON DELETE RESTRICT,
  status        app.enrollment_status NOT NULL DEFAULT 'PENDING',
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  decided_by    uuid REFERENCES app.users (id) ON DELETE RESTRICT,
  decision_note text,
  CONSTRAINT enrollment_decision CHECK (
    (status = 'PENDING' AND decided_at IS NULL AND decided_by IS NULL AND decision_note IS NULL)
    OR (status IN ('ACCEPTED', 'REFUSED') AND decided_at IS NOT NULL AND decided_by IS NOT NULL)
  ),
  CONSTRAINT enrollment_note_len CHECK (decision_note IS NULL OR char_length(decision_note) BETWEEN 1 AND 500)
);
CREATE UNIQUE INDEX enrollment_one_pending ON app.enrollment_requests (user_id) WHERE status = 'PENDING';
CREATE INDEX enrollment_user_created_idx ON app.enrollment_requests (user_id, created_at DESC);

-- « Demande valide » (§ 2.2, R9). Verrous dans l'ordre global : classes puis users.
CREATE FUNCTION app.enrollment_request_valid() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  c_status app.class_status;
  u_status app.user_status;
  u_role   app.global_role;
BEGIN
  SELECT status INTO c_status FROM app.classes WHERE id = NEW.class_id FOR SHARE;
  IF c_status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'enrollment: class is not active' USING ERRCODE = 'check_violation';
  END IF;
  SELECT status, global_role INTO u_status, u_role FROM app.users WHERE id = NEW.user_id FOR SHARE;
  IF u_status IS DISTINCT FROM 'ACTIVE' OR u_role IS DISTINCT FROM 'USER' THEN
    RAISE EXCEPTION 'enrollment: user cannot enroll' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM app.enrollment_requests r
     WHERE r.user_id = NEW.user_id AND r.class_id = NEW.class_id
       AND r.status = 'REFUSED' AND r.decided_at > now() - interval '24 hours'
  ) THEN
    RAISE EXCEPTION 'enrollment: refused less than 24 hours ago' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER enrollment_request_valid BEFORE INSERT ON app.enrollment_requests
  FOR EACH ROW EXECUTE FUNCTION app.enrollment_request_valid();

GRANT SELECT ON app.enrollment_requests TO cp_app;
GRANT INSERT (id, user_id, class_id, created_at) ON app.enrollment_requests TO cp_app;

CREATE TYPE app.audit_source AS ENUM ('APP', 'PRIVILEGED');
CREATE TYPE app.audit_action AS ENUM (
  'ADMIN_CREATED', 'CLASS_CREATED', 'ACCOUNT_REGISTERED', 'PASSWORD_CHANGED', 'SESSIONS_REVOKED',
  'ACCOUNT_ANONYMIZED', 'NOTIFICATIONS_PURGED', 'CHAT_PURGED',
  'ADMIN_RECOVERY_CODE_ISSUED', 'ADMIN_SECOND_FACTOR_BLOCK_CLEARED', 'DATABASE_RESTORED'
);
CREATE TABLE app.audit_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  source        app.audit_source NOT NULL DEFAULT 'APP',
  db_login_role text NOT NULL DEFAULT session_user,
  actor_user_id uuid REFERENCES app.users (id) ON DELETE RESTRICT,
  action        app.audit_action NOT NULL,
  target_type   text,
  target_id     uuid,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT audit_metadata_object CHECK (jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 4096),
  CONSTRAINT audit_target CHECK (
    (target_type IS NULL AND target_id IS NULL)
    OR (target_type IN ('USER', 'CLASS', 'SESSION', 'ENROLLMENT_REQUEST') AND target_id IS NOT NULL)
  )
);
CREATE INDEX audit_log_occurred_idx ON app.audit_log (occurred_at);

CREATE FUNCTION app.audit_log_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  NEW.occurred_at := now();
  NEW.db_login_role := session_user;
  NEW.source := CASE WHEN current_user = 'cp_privileged' THEN 'PRIVILEGED' ELSE 'APP' END::app.audit_source;
  IF NEW.source = 'APP' AND NEW.action IN (
    'ACCOUNT_ANONYMIZED', 'NOTIFICATIONS_PURGED', 'CHAT_PURGED',
    'ADMIN_RECOVERY_CODE_ISSUED', 'ADMIN_SECOND_FACTOR_BLOCK_CLEARED', 'DATABASE_RESTORED'
  ) THEN
    RAISE EXCEPTION 'audit: action reserved to PRIVILEGED source' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER audit_log_guard BEFORE INSERT ON app.audit_log
  FOR EACH ROW EXECUTE FUNCTION app.audit_log_guard();

GRANT SELECT ON app.audit_log TO cp_app;
GRANT INSERT (actor_user_id, action, target_type, target_id, metadata) ON app.audit_log TO cp_app;

COMMIT;
