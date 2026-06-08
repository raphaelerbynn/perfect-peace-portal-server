-- Runs ONCE when the Postgres data volume is first created (empty).
--
-- The Sequelize models are all pinned to `schema: 'dbo'` (a carry-over from the
-- original SQL Server origin), so the ORM issues every query against
-- "dbo"."<Table>". This guarantees that schema exists before the app starts.
--
-- Your data-move script must create the tables INSIDE this `dbo` schema with the
-- exact table names the models expect (e.g. "dbo"."Student", "dbo"."Student_marks",
-- "dbo"."Salary_payment", ...). If your script already runs `CREATE SCHEMA dbo`
-- (without IF NOT EXISTS), delete this file to avoid a conflict.

CREATE SCHEMA IF NOT EXISTS dbo;
