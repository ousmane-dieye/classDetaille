-- db-bootstrap-database.sql — psql -v dbname=<nom>, exécuté par postgres, rejouable.
\set ON_ERROR_STOP on

SELECT format('CREATE DATABASE %I OWNER cp_owner', :'dbname')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'dbname') \gexec

SELECT format('ALTER DATABASE %I OWNER TO cp_owner', :'dbname') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'dbname') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO cp_owner, cp_app, cp_ops, cp_monitor', :'dbname') \gexec
-- Aucun ALTER DATABASE … SET (§ 7.2.7).

\connect :"dbname"
REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
