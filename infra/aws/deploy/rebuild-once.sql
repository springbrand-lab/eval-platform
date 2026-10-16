\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT json_build_object(
  'database', current_database(), 'role', current_user,
  'address', inet_server_addr(), 'port', inet_server_port()
) AS eval_database_rebuild_target;
DO $guard$
BEGIN
  IF current_database() <> 'eval-platform' OR current_user <> 'eval_platform_app' THEN
    RAISE EXCEPTION 'Rebuild requires database eval-platform and role eval_platform_app';
  END IF;
  IF EXISTS (
    SELECT FROM pg_namespace
    WHERE nspname NOT IN ('public', 'drizzle', 'pgboss', 'information_schema')
      AND nspname NOT LIKE 'pg\_%' ESCAPE '\'
  ) THEN
    RAISE EXCEPTION 'Unexpected schema; database was not rebuilt';
  END IF;
END
$guard$;
\if :apply_rebuild
DO $quiescence$
BEGIN
  IF EXISTS (
    SELECT FROM pg_stat_activity
    WHERE datname = current_database() AND pid <> pg_backend_pid()
  ) THEN
    RAISE EXCEPTION 'Other database connections remain; database was not rebuilt';
  END IF;
  IF to_regclass('pgboss.job') IS NOT NULL THEN
    IF EXISTS (SELECT FROM pgboss.job WHERE state = 'active') THEN
      RAISE EXCEPTION 'Active Run jobs remain; database was not rebuilt';
    END IF;
  END IF;
END
$quiescence$;
DROP SCHEMA IF EXISTS pgboss CASCADE;
DROP SCHEMA IF EXISTS drizzle CASCADE;
DROP SCHEMA public CASCADE;
CREATE SCHEMA public AUTHORIZATION CURRENT_USER;
\endif
COMMIT;
