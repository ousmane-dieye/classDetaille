-- classification: expand
BEGIN;

-- Levée du blocage : seuls les échecs postérieurs à cette date comptent pour le blocage suivant.
ALTER TABLE app.users ADD COLUMN second_factor_cleared_at timestamptz;
GRANT UPDATE (second_factor_cleared_at) ON app.users TO cp_privileged;

SET LOCAL ROLE cp_privileged;

CREATE OR REPLACE FUNCTION priv.issue_admin_recovery_code(p_email text, p_challenge_id uuid, p_code_hmac bytea, p_clear_block boolean)
RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_user app.users%ROWTYPE;
  v_expires timestamptz;
  v_admin record;
BEGIN
  -- Ordre des verrous : users avant auth_challenges. Comparaison en texte : les opérateurs citext
  -- ne sont pas dans le chemin de recherche restreint.
  SELECT * INTO v_user FROM app.users
   WHERE email::text = p_email AND status = 'ACTIVE' AND global_role = 'ADMIN' FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TARGET_NOT_ACTIVE_ADMIN' USING ERRCODE = 'P0002';
  END IF;

  -- § 3.3 : un compte bloqué ne reçoit ni vérification ni email sans --clear-block.
  IF v_user.second_factor_blocked_at IS NOT NULL THEN
    IF NOT p_clear_block THEN
      RAISE EXCEPTION 'TARGET_BLOCKED' USING ERRCODE = 'P0003';
    END IF;
    -- Les échecs antérieurs ne comptent plus : le compte repart de zéro (clock_timestamp(), pas now()).
    UPDATE app.users SET second_factor_blocked_at = NULL, second_factor_cleared_at = clock_timestamp() WHERE id = v_user.id;
    INSERT INTO app.audit_log (actor_user_id, action, target_type, target_id, metadata)
    VALUES (NULL, 'ADMIN_SECOND_FACTOR_BLOCK_CLEARED', 'USER', v_user.id, '{}'::jsonb);
  END IF;

  UPDATE app.auth_challenges SET consumed_at = clock_timestamp(), consumed_reason = 'SUPERSEDED'
   WHERE user_id = v_user.id AND purpose = 'RECOVERY' AND consumed_at IS NULL;
  v_expires := clock_timestamp() + interval '15 minutes';
  INSERT INTO app.auth_challenges (id, user_id, purpose, code_hmac, expires_at)
  VALUES (p_challenge_id, v_user.id, 'RECOVERY', p_code_hmac, v_expires);

  INSERT INTO app.audit_log (actor_user_id, action, target_type, target_id, metadata)
  VALUES (NULL, 'ADMIN_RECOVERY_CODE_ISSUED', 'USER', v_user.id, '{}'::jsonb);

  FOR v_admin IN SELECT id, email::text AS email FROM app.users WHERE status = 'ACTIVE' AND global_role = 'ADMIN' ORDER BY id LOOP
    INSERT INTO app.email_outbox (id, recipient_user_id, to_address, kind, dedupe_key, payload, message_id, expires_at)
    VALUES (uuidv7(), v_admin.id, v_admin.email, 'ADMIN_SECURITY_ALERT',
            'admin-recovery-alert:' || p_challenge_id::text || ':' || v_admin.id::text,
            jsonb_build_object('event', 'RECOVERY_CODE_ISSUED', 'accountEmail', v_user.email::text),
            gen_random_uuid()::text, clock_timestamp() + interval '24 hours')
    ON CONFLICT (dedupe_key) DO NOTHING;
  END LOOP;
  RETURN v_expires;
END $$;

RESET ROLE;

COMMIT;
