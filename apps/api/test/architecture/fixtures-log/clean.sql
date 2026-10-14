-- Fixture : aucune forme interdite (ne doit pas être détecté).
ALTER ROLE cp_app SET transaction_timeout = '10s';
ALTER ROLE cp_app RESET log_statement;
select exists (select 1 from pg_db_role_setting s, unnest(s.setconfig) c where c ilike 'log\_%');
SET LOCAL ROLE cp_privileged;
