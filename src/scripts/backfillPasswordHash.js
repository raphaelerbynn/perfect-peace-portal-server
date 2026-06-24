/**
 * Non-destructive password-hash backfill.
 *
 * Adds a NEW `passwordHash` column (if missing) to the Teacher, User_account
 * and Student tables and populates it with a bcrypt hash, WITHOUT touching the
 * existing `password` column. The live system still authenticates against the
 * plaintext `password` column, so this script can be run safely ahead of the
 * code cut-over (when auth is flipped to read/write `passwordHash`).
 *
 * Per row, `passwordHash` is set to:
 *   - bcrypt.hash(password)  when `password` is plaintext, OR
 *   - the existing value     when `password` is already a bcrypt hash
 *                            (e.g. a previous in-place run), copied across.
 * Rows are skipped when `password` is empty/null or `passwordHash` is already
 * a bcrypt hash, so the script is idempotent and safe to re-run.
 *
 * Run with:  npm run backfill-password-hash
 * (Requires DB access — uses the existing Sequelize config / .env.)
 */
import bcrypt from "bcrypt";
import { DataTypes } from "sequelize";
import sequelize from "../config/database.js";
import { Teacher, UserAccount, Student } from "../models/index.js";

const BCRYPT_ROUNDS = 10;
const HASH_COLUMN = "passwordHash";

// A bcrypt hash always begins with "$2a$", "$2b$" or "$2y$".
const isBcryptHash = (value) =>
  typeof value === "string" && value.startsWith("$2");

// Tables that carry a login password. idColumn = the DB column of the primary
// key (used for the targeted UPDATE).
const targets = [
  { Model: Teacher, label: "Teacher", idColumn: "teacher_id" },
  { Model: UserAccount, label: "UserAccount", idColumn: "username" },
  { Model: Student, label: "Student", idColumn: "student_id" },
];

// Add the passwordHash column if it isn't there yet (idempotent).
const ensureColumn = async (qi, table) => {
  const description = await qi.describeTable(table);
  if (description[HASH_COLUMN]) return false;
  await qi.addColumn(table, HASH_COLUMN, {
    type: DataTypes.STRING(255),
    allowNull: true,
  });
  return true;
};

const backfill = async (qi, qg, { Model, label, idColumn }) => {
  const table = Model.getTableName(); // schema-qualified descriptor
  const added = await ensureColumn(qi, table);
  if (added) console.log(`  [${label}] + added "${HASH_COLUMN}" column`);

  const quotedTable = qg.quoteTable(table);
  const idCol = qg.quoteIdentifier(idColumn);
  const pwCol = qg.quoteIdentifier("password");
  const hashCol = qg.quoteIdentifier(HASH_COLUMN);

  const [rows] = await sequelize.query(
    `SELECT ${idCol} AS id, ${pwCol} AS pw, ${hashCol} AS pwh FROM ${quotedTable}`
  );

  let hashed = 0;
  let copied = 0;
  let skipped = 0;

  for (const row of rows) {
    const { id, pw, pwh } = row;

    // Already backfilled — leave it.
    if (isBcryptHash(pwh)) {
      skipped++;
      continue;
    }

    // No plaintext to work with.
    if (!pw) {
      skipped++;
      continue;
    }

    let newHash;
    if (isBcryptHash(pw)) {
      // `password` was already hashed by a prior in-place run — just copy it
      // across so passwordHash is populated; we can't recover the plaintext.
      newHash = pw;
      copied++;
    } else {
      newHash = await bcrypt.hash(String(pw), BCRYPT_ROUNDS);
      hashed++;
    }

    // Targeted UPDATE of ONLY the new column. `password` is never written.
    await qi.bulkUpdate(table, { [HASH_COLUMN]: newHash }, { [idColumn]: id });
  }

  console.log(
    `[${label}] done — hashed: ${hashed}, copied-existing-hash: ${copied}, skipped (already hashed/empty): ${skipped}`
  );
};

const run = async () => {
  try {
    await sequelize.authenticate();
    console.log("Connected to database. Backfilling passwordHash...\n");

    const qi = sequelize.getQueryInterface();
    const qg = qi.queryGenerator;

    for (const target of targets) {
      await backfill(qi, qg, target);
    }

    console.log("\npasswordHash backfill complete. The `password` column was left untouched.");
    await sequelize.close();
    process.exit(0);
  } catch (err) {
    console.error("passwordHash backfill failed:", err);
    try {
      await sequelize.close();
    } catch (_) {
      /* ignore */
    }
    process.exit(1);
  }
};

run();
