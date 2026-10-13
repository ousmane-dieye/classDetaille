-- db-bootstrap-cluster.sql — exécuté par postgres, rejouable sans dommage.
\set ON_ERROR_STOP on

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['cp_owner','cp_app','cp_ops','cp_monitor'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I LOGIN', r);
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cp_privileged') THEN
    CREATE ROLE cp_privileged NOLOGIN;
  END IF;
END $$;

ALTER ROLE cp_owner      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE cp_app        NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE cp_ops        NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE cp_monitor    NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE cp_privileged NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOLOGIN;

GRANT cp_privileged TO cp_owner;

-- Délais de cp_app : sur le rôle lui-même, jamais IN DATABASE (§ 7.2.7).
ALTER ROLE cp_app SET transaction_timeout = '10s';
ALTER ROLE cp_app SET idle_in_transaction_session_timeout = '10s';

-- [C — conditionnel T-01] En production, aucun mot de passe : authentification par certificat.
-- En développement et en test, les mots de passe sont posés séparément (tâche 5), jamais ici.
