-- classification: expand
BEGIN;

-- Actions d'audit du lot 2 (R17). Les valeurs ne sont pas utilisées dans cette transaction.
ALTER TYPE app.audit_action ADD VALUE IF NOT EXISTS 'ENROLLMENT_ACCEPTED';
ALTER TYPE app.audit_action ADD VALUE IF NOT EXISTS 'ENROLLMENT_REFUSED';
ALTER TYPE app.audit_action ADD VALUE IF NOT EXISTS 'MEMBER_REMOVED';
ALTER TYPE app.audit_action ADD VALUE IF NOT EXISTS 'MEMBER_TRANSFERRED';
ALTER TYPE app.audit_action ADD VALUE IF NOT EXISTS 'DELEGATE_APPOINTED';
ALTER TYPE app.audit_action ADD VALUE IF NOT EXISTS 'DELEGATE_REVOKED';
ALTER TYPE app.audit_action ADD VALUE IF NOT EXISTS 'CLASS_ARCHIVED';
ALTER TYPE app.audit_action ADD VALUE IF NOT EXISTS 'SUBJECT_CREATED';
ALTER TYPE app.audit_action ADD VALUE IF NOT EXISTS 'SUBJECT_DELETED';
ALTER TYPE app.audit_action ADD VALUE IF NOT EXISTS 'ACCOUNT_DELETED';

-- Cible « matière » pour l'audit des matières (§ 2.5).
ALTER TABLE app.audit_log DROP CONSTRAINT audit_target;
ALTER TABLE app.audit_log ADD CONSTRAINT audit_target CHECK (
  (target_type IS NULL AND target_id IS NULL)
  OR (target_type IN ('USER', 'CLASS', 'SESSION', 'ENROLLMENT_REQUEST', 'SUBJECT') AND target_id IS NOT NULL)
);

-- § 2.2 : une personne appartient à une classe à la fois, en étudiant ou en délégué.
CREATE TYPE app.class_role AS ENUM ('STUDENT', 'DELEGATE');
-- L'ordre des valeurs est l'ordre des motifs de départ (§ 0.2, § 0.3).
CREATE TYPE app.leave_reason AS ENUM ('REMOVED', 'TRANSFER', 'CLASS_ARCHIVED', 'ACCOUNT_DELETED');

CREATE TABLE app.class_memberships (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES app.users (id) ON DELETE RESTRICT,
  class_id    uuid NOT NULL REFERENCES app.classes (id) ON DELETE RESTRICT,
  role        app.class_role NOT NULL DEFAULT 'STUDENT',
  joined_at   timestamptz NOT NULL DEFAULT now(),
  left_at     timestamptz,
  left_reason app.leave_reason,
  left_by     uuid REFERENCES app.users (id) ON DELETE RESTRICT,
  left_note   text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- Clôture : date et motif toujours ensemble (§ 0.2).
  CONSTRAINT membership_departure CHECK (
    (left_at IS NULL AND left_reason IS NULL AND left_by IS NULL AND left_note IS NULL)
    OR (left_at IS NOT NULL AND left_reason IS NOT NULL)
  ),
  CONSTRAINT membership_note_len CHECK (left_note IS NULL OR char_length(left_note) BETWEEN 1 AND 500)
);
-- Une seule appartenance active par utilisateur (§ 2.2).
CREATE UNIQUE INDEX membership_one_active ON app.class_memberships (user_id) WHERE left_at IS NULL;
CREATE INDEX membership_class_active_idx ON app.class_memberships (class_id) WHERE left_at IS NULL;

GRANT SELECT ON app.class_memberships TO cp_app;
GRANT INSERT (id, user_id, class_id, role, joined_at, created_at, updated_at) ON app.class_memberships TO cp_app;
-- Nomination et clôture par écriture de colonnes : aucune ligne n'est jamais supprimée (§ 2.2).
GRANT UPDATE (role, left_at, left_reason, left_by, left_note, updated_at) ON app.class_memberships TO cp_app;

-- Délégués : la limite vit en base, jamais seulement dans l'application (§ 0.2, R8).
-- Le verrou `classes FOR NO KEY UPDATE` sérialise les nominations concurrentes ; les services verrouillent
-- `classes` avant toute écriture sur `class_memberships` (ordre global § 2.1).
CREATE FUNCTION app.membership_delegate_limit() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  n     int;
  max_d int;
BEGIN
  IF NEW.role <> 'DELEGATE' OR NEW.left_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT max_delegates INTO max_d FROM app.classes WHERE id = NEW.class_id FOR NO KEY UPDATE;
  SELECT count(*)::int INTO n FROM app.class_memberships
   WHERE class_id = NEW.class_id AND left_at IS NULL AND role = 'DELEGATE' AND id <> NEW.id;
  IF n >= max_d THEN
    RAISE EXCEPTION 'membership: delegate limit reached' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER membership_delegate_limit BEFORE INSERT OR UPDATE OF role ON app.class_memberships
  FOR EACH ROW EXECUTE FUNCTION app.membership_delegate_limit();

-- Appartenance valide : classe active et compte actif (§ 0.2).
-- Verrous dans l'ordre global : classes (FOR SHARE) puis users (§ 2.1) ; la clôture d'une appartenance est libre.
CREATE FUNCTION app.membership_valid() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  c_status app.class_status;
  u_status app.user_status;
  u_role   app.global_role;
BEGIN
  IF NEW.left_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT status INTO c_status FROM app.classes WHERE id = NEW.class_id FOR SHARE;
  IF c_status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'membership: class is not active' USING ERRCODE = 'check_violation';
  END IF;
  SELECT status, global_role INTO u_status, u_role FROM app.users WHERE id = NEW.user_id FOR SHARE;
  IF u_status IS DISTINCT FROM 'ACTIVE' OR u_role IS DISTINCT FROM 'USER' THEN
    RAISE EXCEPTION 'membership: user cannot join' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER membership_valid BEFORE INSERT OR UPDATE ON app.class_memberships
  FOR EACH ROW EXECUTE FUNCTION app.membership_valid();

-- § 2.2, R12 : matières d'une classe, nom unique insensible à la casse.
CREATE TABLE app.subjects (
  id         uuid PRIMARY KEY,
  class_id   uuid NOT NULL REFERENCES app.classes (id) ON DELETE RESTRICT,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subjects_name_len CHECK (char_length(name) BETWEEN 2 AND 60)
);
CREATE UNIQUE INDEX subjects_one_name_per_class ON app.subjects (class_id, lower(name));
GRANT SELECT ON app.subjects TO cp_app;
GRANT INSERT (id, class_id, name, created_at) ON app.subjects TO cp_app;

-- Une matière ne se crée pas dans une classe archivée (§ 0.3).
CREATE FUNCTION app.subjects_class_active() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE c_status app.class_status;
BEGIN
  SELECT status INTO c_status FROM app.classes WHERE id = NEW.class_id FOR SHARE;
  IF c_status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'subjects: class is not active' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER subjects_class_active BEFORE INSERT ON app.subjects
  FOR EACH ROW EXECUTE FUNCTION app.subjects_class_active();

-- § 2.2, R10 : limite de délégués et quotas de stockage (colonnes du lot 3 pour les quotas).
ALTER TABLE app.classes ADD COLUMN max_delegates smallint NOT NULL DEFAULT 2;
ALTER TABLE app.classes ADD COLUMN storage_quota_bytes bigint;
ALTER TABLE app.classes ADD COLUMN storage_reserved_bytes bigint NOT NULL DEFAULT 0;
ALTER TABLE app.classes ADD CONSTRAINT classes_max_delegates CHECK (max_delegates BETWEEN 1 AND 5);
ALTER TABLE app.classes ADD CONSTRAINT classes_storage CHECK (
  storage_reserved_bytes >= 0 AND (storage_quota_bytes IS NULL OR storage_quota_bytes > 0)
);
-- Archivage (§ 0.3) : cp_app écrit le statut de la classe (avec archived_at, ensemble — contrainte classes_archive_state).
GRANT UPDATE (status, archived_at) ON app.classes TO cp_app;

-- Décisions d'admission (§ 0.3) : les quatre colonnes de décision s'écrivent ensemble, jamais de DELETE.
GRANT UPDATE (status, decided_at, decided_by, decision_note) ON app.enrollment_requests TO cp_app;

-- Décision définitive (§ 0.3) : aucune écriture sur une demande déjà tranchée.
CREATE FUNCTION app.enrollment_decision_final() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'enrollment: decision is final' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER enrollment_decision_final BEFORE UPDATE ON app.enrollment_requests
  FOR EACH ROW EXECUTE FUNCTION app.enrollment_decision_final();

-- « Demande valide », complément R9 du lot 2 : une personne déjà membre ne redemande pas (§ 0.2, § 0.3).
-- Le verrou `classes FOR SHARE` pris au début du déclencheur exclut une acceptation en cours (qui tient
-- `classes FOR NO KEY UPDATE`) ; le cas résiduel (autre classe) est neutralisé au moment de la décision par
-- l'index d'appartenance active et la pré-vérification du service.
CREATE OR REPLACE FUNCTION app.enrollment_request_valid() RETURNS trigger
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
    SELECT 1 FROM app.class_memberships m
     WHERE m.user_id = NEW.user_id AND m.left_at IS NULL
  ) THEN
    RAISE EXCEPTION 'enrollment: user is already a member' USING ERRCODE = 'check_violation';
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

COMMIT;
