// TEST-CLIENT seed — creates EXACTLY ONE user: the Administrator management
// account used to log into the admin portal. Nothing else is seeded (the client
// adds classes/staff/students through the UI). Idempotent: re-running updates the
// admin's password instead of failing.
//
// Credentials come from the environment so they can be supplied at deploy time
// (GitHub secrets) or interactively by scripts/run-test-client.sh:
//   ADMIN_USERNAME  (default "admin")
//   ADMIN_PASSWORD  (REQUIRED in real deploys — a default is used only for local)
//   ADMIN_EMAIL     (optional)
//   ADMIN_NAME      (optional, display name)
//
// Runs from the COMPILED image: `node dist/scripts/seedAdmin.js`.
import bcrypt from "bcrypt";
import sequelize from "../config/database.js";
import { UserAccount } from "../models/index.js";

const ROUNDS = 10;
const ADMIN_CATEGORY = "Administrator";

const run = async () => {
  const username = process.env.ADMIN_USERNAME || "admin";
  const password = process.env.ADMIN_PASSWORD || "ChangeMe@5040";
  const email = process.env.ADMIN_EMAIL || "";
  const name = process.env.ADMIN_NAME || "Administrator";

  if (!process.env.ADMIN_PASSWORD) {
    console.warn(
      "⚠️  ADMIN_PASSWORD not set — using the insecure default 'ChangeMe@5040'. " +
        "Set ADMIN_PASSWORD for any real deployment."
    );
  }

  await sequelize.authenticate();
  console.log(`Connected to ${sequelize.getDatabaseName()} — seeding admin '${username}'…`);

  const hash = await bcrypt.hash(password, ROUNDS);

  const existing = await UserAccount.findByPk(username);
  if (existing) {
    existing.password = hash;
    existing.category = ADMIN_CATEGORY;
    existing.email = email || existing.email;
    existing.name = name || existing.name;
    existing.isDeleted = false;
    await existing.save();
    console.log(`✅ Updated existing admin account '${username}'.`);
  } else {
    await UserAccount.create({
      username,
      name,
      email,
      category: ADMIN_CATEGORY,
      password: hash,
      teacherId: null,
    });
    console.log(`✅ Created admin account '${username}'.`);
  }

  console.log("");
  console.log("   Admin portal login:");
  console.log(`     username: ${username}`);
  console.log(`     category: ${ADMIN_CATEGORY}`);
  console.log(`     password: ${process.env.ADMIN_PASSWORD ? "(from ADMIN_PASSWORD)" : password}`);
  process.exit(0);
};

run().catch((err) => {
  console.error("❌ seedAdmin failed:", err.message);
  process.exit(1);
});
