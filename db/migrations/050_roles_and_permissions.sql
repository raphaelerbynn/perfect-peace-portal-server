-- 050 (B10): staff roles and permissions.
--
--   Role             an office login role. role_id 1-3 are the SYSTEM roles
--                    (Administrator, Class Teacher, Accountant): read-only,
--                    their permissions are fixed in code
--                    (src/utils/permissions.js SYSTEM_ROLES), so they have no
--                    Role_permission rows. Custom roles (is_system = FALSE) are
--                    made by the school on Settings -> Roles.
--   Role_permission  the permission keys a custom role holds (the catalogue is
--                    in code; unknown keys are ignored by the app).
--   User_account.role_id
--                    the login's role. Backfilled from category for the three
--                    system role names (exact match, as the old role check
--                    compared). category stays: the app keeps it equal to the
--                    role's name, and tokens signed before B10 carry it.
--                    A login whose category is none of the three keeps
--                    role_id NULL and, as before, reaches no office page.
--
-- Nobody's access changes: the system roles' code sets reproduce what each
-- role reached before (src/__tests__/roleAccess.test.js).
--
-- move-data creates every table from the models before migrations run, so the
-- CREATE TABLEs and ADD COLUMN may be skipped there: defaults, constraints,
-- indexes and the seed are added by name either way. Safe to re-run.

-- ---------------------------------------------------------------- Role
CREATE TABLE IF NOT EXISTS "dbo"."Role" (
  role_id     SERIAL PRIMARY KEY,
  name        VARCHAR(50)  NOT NULL,
  description VARCHAR(200),
  is_system   BOOLEAN      NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL,
  created_by  VARCHAR(50),
  updated_at  TIMESTAMPTZ  NOT NULL,
  updated_by  VARCHAR(50)
);
ALTER TABLE "dbo"."Role" ALTER COLUMN is_system SET DEFAULT FALSE;
ALTER TABLE "dbo"."Role" ALTER COLUMN created_at SET DEFAULT NOW();
ALTER TABLE "dbo"."Role" ALTER COLUMN updated_at SET DEFAULT NOW();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'role_name_not_blank_chk') THEN
    ALTER TABLE "dbo"."Role" ADD CONSTRAINT role_name_not_blank_chk CHECK (btrim(name) <> '');
  END IF;
END $$;

-- "Head Teacher" and " head teacher " are the same role.
CREATE UNIQUE INDEX IF NOT EXISTS role_name_ci_uq ON "dbo"."Role" (lower(btrim(name)));

-- ---------------------------------------------------------------- Role_permission
CREATE TABLE IF NOT EXISTS "dbo"."Role_permission" (
  role_id        INTEGER     NOT NULL,
  permission_key VARCHAR(60) NOT NULL,
  PRIMARY KEY (role_id, permission_key)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Role_permission_role_id_fkey') THEN
    ALTER TABLE "dbo"."Role_permission" ADD CONSTRAINT "Role_permission_role_id_fkey"
      FOREIGN KEY (role_id) REFERENCES "dbo"."Role"(role_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'role_permission_key_chk') THEN
    ALTER TABLE "dbo"."Role_permission" ADD CONSTRAINT role_permission_key_chk
      CHECK (permission_key ~ '^[a-z_]+\.[a-z_]+$');
  END IF;
END $$;

-- ---------------------------------------------------------------- system roles
INSERT INTO "dbo"."Role" (role_id, name, description, is_system, created_at, created_by, updated_at, updated_by) VALUES
  (1, 'Administrator', 'Everything, for every class.', TRUE, NOW(), 'migration 050', NOW(), 'migration 050'),
  (2, 'Class Teacher', 'Results, registers, report cards and news for the class linked to the login.', TRUE, NOW(), 'migration 050', NOW(), 'migration 050'),
  (3, 'Accountant', 'Fees, billing, invoices, accounting and payroll.', TRUE, NOW(), 'migration 050', NOW(), 'migration 050')
ON CONFLICT (role_id) DO NOTHING;

-- New custom roles number from 4 (the ids above were given by hand).
SELECT setval(
  pg_get_serial_sequence('"dbo"."Role"', 'role_id'),
  GREATEST((SELECT MAX(role_id) FROM "dbo"."Role"), 3)
);

-- ---------------------------------------------------------------- User_account.role_id
ALTER TABLE "dbo"."User_account" ADD COLUMN IF NOT EXISTS role_id INTEGER;

UPDATE "dbo"."User_account" u
   SET role_id = r.role_id
  FROM "dbo"."Role" r
 WHERE u.role_id IS NULL
   AND r.is_system
   AND r.role_id IN (1, 2, 3)
   AND r.name = u.category;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'User_account_role_id_fkey') THEN
    ALTER TABLE "dbo"."User_account" ADD CONSTRAINT "User_account_role_id_fkey"
      FOREIGN KEY (role_id) REFERENCES "dbo"."Role"(role_id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS user_account_role_idx ON "dbo"."User_account" (role_id);

-- Logins left without a role (a category that is none of the three): listed,
-- not changed. They reached no office page before and still don't.
DO $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*) INTO n FROM "dbo"."User_account" WHERE role_id IS NULL;
  IF n > 0 THEN
    RAISE NOTICE '050: % office login(s) have no role (category is not Administrator, Class Teacher or Accountant): give them one on People -> Office logins', n;
  END IF;
END $$;
