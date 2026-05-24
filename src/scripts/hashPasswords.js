/**
 * One-time, idempotent password backfill.
 *
 * Hashes any plaintext passwords still stored in the Teacher and User_account
 * tables. A row is skipped if its password already looks like a bcrypt hash
 * (starts with "$2") or is empty/null, so the script is safe to re-run.
 *
 * Run with:  npm run hash-passwords
 * (Requires DB access — uses the existing Sequelize config / .env.)
 */
import bcrypt from "bcrypt";
import sequelize from "../config/database.js";
import { Teacher, UserAccount } from "../models/index.js";

const BCRYPT_ROUNDS = 10;

// A bcrypt hash always begins with "$2a$", "$2b$" or "$2y$".
const isBcryptHash = (value) =>
  typeof value === "string" && value.startsWith("$2");

const backfillModel = async (Model, label, idField) => {
  const rows = await Model.findAll();
  let hashed = 0;
  let skipped = 0;

  for (const row of rows) {
    const current = row.password;
    const rowId = row[idField];

    if (!current) {
      // Null / empty password (e.g. account never set up) — nothing to hash.
      skipped++;
      continue;
    }

    if (isBcryptHash(current)) {
      skipped++;
      continue;
    }

    const hash = await bcrypt.hash(current, BCRYPT_ROUNDS);
    row.password = hash;
    await row.save();
    hashed++;
    console.log(`  [${label}] hashed password for ${idField}=${rowId}`);
  }

  console.log(`[${label}] done — hashed: ${hashed}, skipped (already hashed/empty): ${skipped}`);
};

const run = async () => {
  try {
    await sequelize.authenticate();
    console.log("Connected to database. Starting password backfill...\n");

    await backfillModel(Teacher, "Teacher", "teacherId");
    await backfillModel(UserAccount, "UserAccount", "username");

    console.log("\nPassword backfill complete.");
    await sequelize.close();
    process.exit(0);
  } catch (err) {
    console.error("Password backfill failed:", err);
    try {
      await sequelize.close();
    } catch (_) {
      /* ignore */
    }
    process.exit(1);
  }
};

run();
