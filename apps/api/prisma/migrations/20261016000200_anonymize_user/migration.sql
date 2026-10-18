-- classification: expand
BEGIN;

-- R4, § 2.6 : anonymisation d'un compte. La fonction est la SEULE voie d'effacement ; cp_app ne fait
-- que l'appeler (l'application fait foi pour l'identité de l'acteur, la fonction vérifie ses droits à
-- partir de l'état de la base et limite les dégâts à cinq anonymisations par acteur sur 24 h).
-- Droits de cp_privileged : colonne par colonne, comme pour priv.issue_admin_recovery_code.
GRANT UPDATE (email, first_name, last_name, password_hash, global_role, status, email_flagged_at,
              email_reminders, email_announcements, unsubscribe_token_hash, deleted_at, updated_at)
  ON app.users TO cp_privileged;
GRANT SELECT ON app.sessions TO cp_privileged;
GRANT UPDATE (revoked_at, revoke_reason) ON app.sessions TO cp_privileged;
GRANT SELECT ON app.class_memberships TO cp_privileged;
GRANT UPDATE (left_at, left_reason, left_by, left_note, updated_at) ON app.class_memberships TO cp_privileged;
GRANT SELECT ON app.enrollment_requests TO cp_privileged;
GRANT UPDATE (status, decided_at, decided_by, decision_note) ON app.enrollment_requests TO cp_privileged;
-- Annulation des emails en attente : adresse et contenu vidés (§ 2.6).
GRANT UPDATE (to_address, payload) ON app.email_outbox TO cp_privileged;
GRANT UPDATE (smtp_response) ON app.email_attempts TO cp_privileged;
-- Le compteur d'activité (cinq par acteur sur 24 h) se lit dans l'audit PRIVILEGED.
GRANT SELECT ON app.audit_log TO cp_privileged;

-- Une demande annulée parce que le compte disparaît n'est ni acceptée ni refusée (§ 2.6).
-- La valeur n'est pas référencée comme littéral d'énumération (elle vient d'être ajoutée).
ALTER TYPE app.enrollment_status ADD VALUE IF NOT EXISTS 'CANCELLED';

ALTER TABLE app.enrollment_requests DROP CONSTRAINT enrollment_decision;
ALTER TABLE app.enrollment_requests ADD CONSTRAINT enrollment_decision CHECK (
  (status::text = 'PENDING' AND decided_at IS NULL AND decided_by IS NULL AND decision_note IS NULL)
  OR (status::text IN ('ACCEPTED', 'REFUSED') AND decided_at IS NOT NULL AND decided_by IS NOT NULL)
  -- Annulée par l'anonymisation : date de la clôture, aucun décideur, aucun motif.
  OR (status::text = 'CANCELLED' AND decided_at IS NOT NULL AND decided_by IS NULL AND decision_note IS NULL)
);

-- Une décision est définitive : seule l'anonymisation peut effacer le motif d'une demande déjà tranchée,
-- et elle ne peut rien changer d'autre (jamais le statut ni le décideur).
CREATE OR REPLACE FUNCTION app.enrollment_decision_final() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.status <> 'PENDING' AND (
       current_user <> 'cp_privileged'
    OR NEW.status IS DISTINCT FROM OLD.status
    OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
    OR NEW.decided_by IS DISTINCT FROM OLD.decided_by
  ) THEN
    RAISE EXCEPTION 'enrollment: decision is final' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- priv appartient à cp_privileged : cp_owner agit en prenant explicitement le rôle propriétaire
-- (cf. fondations), y compris pour accorder à cp_app l'accès au schéma de cette seule fonction.
SET LOCAL ROLE cp_privileged;

GRANT USAGE ON SCHEMA priv TO cp_app;

CREATE FUNCTION priv.anonymize_user(p_user uuid, p_actor uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_target  record;
  v_actor   record;
  v_used    int;
BEGIN
  IF p_user IS NULL OR p_actor IS NULL THEN
    RAISE EXCEPTION 'anonymize: missing identifier' USING ERRCODE = '22004';
  END IF;

  -- Verrou de la cible (ordre global § 2.1 : users avant les tables d'appartenance).
  SELECT status, global_role INTO v_target FROM app.users WHERE id = p_user FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'anonymize: unknown target' USING ERRCODE = 'P0002';
  END IF;
  -- Un compte supprimé ou suspendu n'est pas anonymisé : il n'a plus d'identité à effacer.
  IF v_target.status <> 'ACTIVE' OR v_target.global_role <> 'USER' THEN
    RAISE EXCEPTION 'anonymize: target is not an active student' USING ERRCODE = 'P0003';
  END IF;

  -- Les droits de l'acteur sont lus dans la base : la cible elle-même, ou un administrateur actif.
  IF p_actor <> p_user THEN
    SELECT status, global_role INTO v_actor FROM app.users WHERE id = p_actor;
    IF NOT FOUND OR v_actor.status <> 'ACTIVE' OR v_actor.global_role <> 'ADMIN' THEN
      RAISE EXCEPTION 'anonymize: actor is not allowed' USING ERRCODE = 'P0003';
    END IF;
  END IF;

  -- Limite les dégâts : cinq anonymisations par acteur sur 24 h, comptées sur les entrées PRIVILEGED.
  SELECT count(*)::int INTO v_used FROM app.audit_log
   WHERE action = 'ACCOUNT_ANONYMIZED' AND source = 'PRIVILEGED'
     AND actor_user_id = p_actor AND occurred_at > clock_timestamp() - interval '24 hours';
  IF v_used >= 5 THEN
    RAISE EXCEPTION 'anonymize: rate limit reached' USING ERRCODE = 'P0003';
  END IF;

  -- 1. Identité, préférences et jetons effacés ; le compte passe USER et DELETED.
  --    La forme complète de l'anonymisé est portée par le CHECK users_lifecycle.
  UPDATE app.users
     SET email = NULL, first_name = NULL, last_name = NULL, password_hash = NULL,
         global_role = 'USER', status = 'DELETED',
         email_flagged_at = NULL, unsubscribe_token_hash = NULL,
         email_reminders = false, email_announcements = false,
         deleted_at = clock_timestamp(), updated_at = clock_timestamp()
   WHERE id = p_user;

  -- 2. Ses sessions sont révoquées (ANONYMIZED) : la reconnexion vaut 401, jamais une erreur.
  UPDATE app.sessions SET revoked_at = clock_timestamp(), revoke_reason = 'ANONYMIZED'
   WHERE user_id = p_user AND revoked_at IS NULL;

  -- 3. Son appartenance est clôturée (ACCOUNT_DELETED) ; aucune ligne n'est supprimée (§ 2.2).
  UPDATE app.class_memberships
     SET left_at = clock_timestamp(), left_reason = 'ACCOUNT_DELETED', left_by = NULL, left_note = NULL,
         updated_at = clock_timestamp()
   WHERE user_id = p_user AND left_at IS NULL;
  -- Une clôture antérieure conserve son motif mais perd sa note, qui appartenait au compte.
  UPDATE app.class_memberships SET left_note = NULL, updated_at = clock_timestamp()
   WHERE user_id = p_user AND left_note IS NOT NULL;

  -- 4. Ses demandes : la décision tranchée est conservée, son motif effacé ; les attentes sont annulées.
  UPDATE app.enrollment_requests SET decision_note = NULL
   WHERE user_id = p_user AND decision_note IS NOT NULL;
  UPDATE app.enrollment_requests
     SET status = 'CANCELLED', decided_at = clock_timestamp(), decision_note = NULL
   WHERE user_id = p_user AND status = 'PENDING';

  -- 5. Ses emails : annulés, adresse et contenu vidés ; une tentative en cours est close (§ 2.4).
  WITH cancelled AS (
    UPDATE app.email_outbox
       SET status = 'CANCELLED', claim_token = NULL, locked_until = NULL, payload_encrypted = NULL,
           to_address = '', payload = '{}'::jsonb
     WHERE recipient_user_id = p_user AND status IN ('PENDING', 'SENDING', 'RETRY_WAIT', 'UNCERTAIN')
    RETURNING id)
  UPDATE app.email_attempts a
     SET outcome = 'CANCELLED_IN_FLIGHT', finished_at = clock_timestamp(), smtp_response = NULL
    FROM cancelled c WHERE a.email_id = c.id AND a.outcome IS NULL;

  -- 6. L'effacement réel est garanti par la base, en source PRIVILEGED (§ 2.5).
  INSERT INTO app.audit_log (actor_user_id, action, target_type, target_id, metadata)
  VALUES (p_actor, 'ACCOUNT_ANONYMIZED', 'USER', p_user, '{}'::jsonb);
END $$;

REVOKE ALL ON FUNCTION priv.anonymize_user(uuid, uuid) FROM PUBLIC;
-- cp_app appelle la fonction (R4) ; cp_ops et cp_monitor ne l'exécutent pas.
GRANT EXECUTE ON FUNCTION priv.anonymize_user(uuid, uuid) TO cp_app;

RESET ROLE;

COMMIT;
