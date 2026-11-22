-- 051: permission keys may have more than one dot.
--
-- 050 limited Role_permission.permission_key to one dot ("module.action"), but
-- the AI permissions include "ai.papers.view_all" and "ai.suggestions.review",
-- so saving a custom role that holds them failed (role_permission_key_chk).
-- The app already refuses any key that isn't in its catalogue
-- (src/utils/permissions.js); this check only guards the shape:
-- lower-case words joined by dots, at least two parts.
-- Safe to re-run: the constraint is dropped and re-added under the same name.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'role_permission_key_chk') THEN
    ALTER TABLE "dbo"."Role_permission" DROP CONSTRAINT role_permission_key_chk;
  END IF;
  ALTER TABLE "dbo"."Role_permission" ADD CONSTRAINT role_permission_key_chk
    CHECK (permission_key ~ '^[a-z_]+(\.[a-z_]+)+$');
END $$;
