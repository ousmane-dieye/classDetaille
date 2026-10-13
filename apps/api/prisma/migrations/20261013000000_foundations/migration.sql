-- classification: expand
BEGIN;

CREATE SCHEMA IF NOT EXISTS ext;
CREATE SCHEMA IF NOT EXISTS app;
-- cp_owner (propriétaire de la base, membre de cp_privileged) crée priv au nom de cp_privileged.
CREATE SCHEMA IF NOT EXISTS priv AUTHORIZATION cp_privileged;

CREATE EXTENSION IF NOT EXISTS citext SCHEMA ext;
CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA ext;

REVOKE ALL ON SCHEMA app, ext FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO cp_app, cp_ops, cp_monitor;
GRANT USAGE ON SCHEMA ext TO cp_app, cp_ops, cp_monitor, cp_privileged;
-- cp_owner est NOINHERIT : il agit sur priv en prenant explicitement le rôle propriétaire.
SET LOCAL ROLE cp_privileged;
REVOKE ALL ON SCHEMA priv FROM PUBLIC;
GRANT USAGE ON SCHEMA priv TO cp_ops, cp_monitor;
RESET ROLE;

CREATE TABLE app.sync_epoch (
  id    smallint PRIMARY KEY CHECK (id = 1),
  epoch uuid NOT NULL
);
INSERT INTO app.sync_epoch (id, epoch) VALUES (1, gen_random_uuid());
GRANT SELECT ON app.sync_epoch TO cp_app;

CREATE TABLE app.ops_settings (
  id                         smallint PRIMARY KEY CHECK (id = 1),
  orphan_delete_paused_until timestamptz,
  orphan_review_required     boolean NOT NULL DEFAULT false,
  bulk_email_paused          boolean NOT NULL DEFAULT false,
  last_restore_at            timestamptz,
  last_restore_backup_at     timestamptz
);
INSERT INTO app.ops_settings (id) VALUES (1);
GRANT SELECT ON app.ops_settings TO cp_app;

COMMIT;
