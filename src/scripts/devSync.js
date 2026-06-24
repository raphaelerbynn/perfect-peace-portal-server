// DEV-ONLY, throwaway. Creates the (empty) tables in a LOCAL Postgres so the app
// can boot for a smoke test — production boot never syncs (DDL is disabled by
// design). Run against a LOCAL db only, with DB_* env vars overriding .env.
import sequelize from "../config/database.js";
import "../models/index.js"; // registers every model + association on `sequelize`

const run = async () => {
  try {
    await sequelize.authenticate();
    console.log(`Connected to ${sequelize.getDatabaseName()} — syncing schema…`);

    // sequelize.sync() doesn't topologically order tables, so a child table's
    // foreign key can reference a parent that doesn't exist yet. Sync each model
    // individually and retry across passes until every table is created (or no
    // further progress is made — leftover models are created without their FK).
    const models = Object.values(sequelize.models);
    let pending = [...models];
    for (let pass = 1; pending.length && pass <= 10; pass++) {
      const stillPending = [];
      for (const model of pending) {
        try {
          await model.sync();
        } catch (e) {
          stillPending.push(model);
        }
      }
      console.log(`  pass ${pass}: ${pending.length - stillPending.length} created, ${stillPending.length} pending`);
      if (stillPending.length === pending.length) break; // no progress → stop
      pending = stillPending;
    }

    if (pending.length) {
      console.warn(`⚠️  ${pending.length} table(s) could not be created with FKs: ${pending.map((m) => m.name).join(", ")}`);
    }
    console.log("✅ sync pass complete");
    process.exit(pending.length ? 2 : 0);
  } catch (err) {
    console.error("❌ sync failed:", err.message);
    process.exit(1);
  }
};

run();
