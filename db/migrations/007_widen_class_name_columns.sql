-- 007: class names can be 50 characters (Class.name VARCHAR(50)), but the
-- tables that store a copy of the class NAME were 10-20 characters wide. A
-- class called "Basic 1 Gold" (12) saved fine, then every register and KG save
-- for it failed. Widening VARCHAR keeps the data; safe to re-run.
ALTER TABLE "dbo"."Attendance"    ALTER COLUMN class TYPE VARCHAR(50);
ALTER TABLE "dbo"."KG_assessment" ALTER COLUMN class TYPE VARCHAR(50);
ALTER TABLE "dbo"."KG_assessment" ALTER COLUMN promoted TYPE VARCHAR(50);
ALTER TABLE "dbo"."Student"       ALTER COLUMN class TYPE VARCHAR(50);
ALTER TABLE "dbo"."Bus_fee"       ALTER COLUMN class TYPE VARCHAR(50);
ALTER TABLE "dbo"."Extra_classes" ALTER COLUMN class TYPE VARCHAR(50);
ALTER TABLE "dbo"."Feeding_fee"   ALTER COLUMN class TYPE VARCHAR(50);
