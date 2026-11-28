// Start-up for the TEST-CLIENT stack (docker-compose.test-client.yml), run
// before the API on every container start. It looks at the database and picks:
//
//   - a copy of the live data (scripts/push-copy-to-vps.sh put it there; it has
//     "dbo"."_migrations"): apply any pending migrations, nothing else. A
//     refused migration stops the start, so the API never runs on a half-
//     migrated copy.
//   - an empty database (a fresh volume): create the tables and the single
//     admin from ADMIN_USERNAME / ADMIN_PASSWORD, as the stack always did.
//   - tables made that way earlier (no "_migrations"): start as they are.
//
// Usage (in the container, from /app): node dist/scripts/testClientStart.js
import { spawnSync } from "child_process";
import path from "path";
import sequelize from "../config/database.js";

// The folder this script runs from (dist/scripts in the image), taken from the
// command line so it works both as ES module source and as the Babel build.
const here = path.dirname(path.resolve(process.argv[1]));
const run = (script) => {
  const r = spawnSync(process.execPath, [`${here}/${script}`], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`[test-client] ${script} failed (exit ${r.status}); not starting the API.`);
    process.exit(r.status || 1);
  }
};

const tableExists = async (name) => {
  const [rows] = await sequelize.query(`SELECT to_regclass('"dbo"."${name}"') AS t`);
  return Boolean(rows[0]?.t);
};

const main = async () => {
  await sequelize.authenticate();
  const migrated = await tableExists("_migrations");
  const hasTables = await tableExists("Student");
  await sequelize.close();

  if (migrated) {
    console.log("[test-client] database is a copy of the live data: applying pending migrations");
    run("migrate.js");
  } else if (!hasTables) {
    console.log("[test-client] empty database: creating the tables and the single admin");
    run("devSync.js");
    run("seedAdmin.js");
  } else {
    console.log("[test-client] database without migration history: starting it as it is");
  }
};

main().catch((err) => {
  console.error("[test-client] start-up check failed:", err.message);
  process.exit(1);
});
