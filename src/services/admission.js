// B18: automatic admission numbers for new pupils.
//
// Format (School_settings.admission_format), e.g. "PPS/{YYYY}/{0000}":
//   {YYYY} / {YY}  the year the pupil is added (4 or 2 digits)
//   {0000}         the running number, padded to that many digits (1-8 zeros);
//                  exactly one. A number past the padding just gets longer
//                  ({00} -> 99, 100), never cut.
//   anything else  printed as typed: letters, digits, / - _ . and spaces.
// The running number is kept per "scope" (the format with the year filled
// in), so it restarts each year when the format has a year in it.
// The next number is taken under a row lock in the caller's transaction
// (Admission_counter), so two offices adding pupils at once never get the
// same one; a number the office already typed by hand is skipped.
// Existing pupils are never renumbered. Students still sign in with STU/<id>.
import { QueryTypes } from "sequelize";
import sequelize from "../config/database.js";
import { AppError } from "../utils/errorHandling.js";

export const DEFAULT_ADMISSION_FORMAT = "PPS/{YYYY}/{0000}";
export const MAX_ADMISSION_NO = 30; // Student.admission_no VARCHAR(30)
// A format must still fit when the running number has grown past its padding:
// it is checked with an 8-digit number (99,999,999), the widest it is allowed
// to reach (takeNextAdmissionNo refuses anything longer with a 400).
export const WIDEST_SEQUENCE = 99999999;
const TOO_LONG_FORMAT =
  `An admission number can be at most ${MAX_ADMISSION_NO} characters, with room for the running number to grow to 8 digits. Shorten the format.`;
const LITERAL_RE = /^[A-Za-z0-9/\-_. ]*$/;
const TOKEN_RE = /\{(YYYY|YY|0{1,8})\}/g;

// Parse and check a format. Returns null for "no automatic numbers".
export const parseAdmissionFormat = (input) => {
  if (input == null) return null;
  const format = String(input).trim();
  if (!format) return null;
  if (format.length > 40) throw new AppError("The admission number format can be at most 40 characters", 400);
  const seqTokens = format.match(/\{0+\}/g) || [];
  if (seqTokens.length !== 1) {
    throw new AppError("The admission number format needs exactly one running number, e.g. {0000}", 400);
  }
  if (!/\{0{1,8}\}/.test(format)) throw new AppError("The running number can have 1 to 8 digits, e.g. {0000}", 400);
  const literals = format.replace(TOKEN_RE, "");
  if (/[{}]/.test(literals)) {
    throw new AppError("Unknown part in the admission number format. Use {YYYY}, {YY} and {0000}.", 400);
  }
  if (!LITERAL_RE.test(literals)) {
    throw new AppError("The admission number format can only use letters, numbers, spaces and / - _ .", 400);
  }
  if (renderAdmissionNo(format, WIDEST_SEQUENCE).length > MAX_ADMISSION_NO) {
    throw new AppError(TOO_LONG_FORMAT, 400);
  }
  return format;
};

const fillYear = (format, date) => {
  const y = String((date || new Date()).getUTCFullYear());
  return format.replace(/\{YYYY\}/g, y).replace(/\{YY\}/g, y.slice(-2));
};

// The counter scope: the format with the year filled in.
export const admissionScope = (format, date = new Date()) => fillYear(format, date);

export const renderAdmissionNo = (format, seq, date = new Date()) =>
  fillYear(format, date).replace(/\{(0+)\}/, (_m, zeros) => String(seq).padStart(zeros.length, "0"));

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

// The running number inside an existing admission number of this scope
// (any padding, any case), or null.
export const sequenceOf = (scope, admissionNo) => {
  const [before, after] = scope.split(/\{0+\}/);
  const re = new RegExp(`^${escapeRe(before)}(\\d+)${escapeRe(after)}$`, "i");
  const m = re.exec(String(admissionNo ?? "").trim());
  return m ? Number(m[1]) : null;
};

// Highest running number already used in this scope (typed by hand or older
// numbers), so a new counter never starts below them.
const highestUsed = async (scope, transaction) => {
  const [before] = scope.split(/\{0+\}/);
  const rows = await sequelize.query(
    `SELECT s.admission_no AS "admissionNo" FROM "dbo"."Student" s
      WHERE s.admission_no IS NOT NULL AND lower(s.admission_no) LIKE lower(:prefix) || '%'`,
    { replacements: { prefix: before.replace(/[\\%_]/g, "\\$&") }, type: QueryTypes.SELECT, transaction }
  );
  return rows.reduce((max, r) => Math.max(max, sequenceOf(scope, r.admissionNo) ?? 0), 0);
};

const isTaken = async (admissionNo, { transaction, exceptStudentId = null } = {}) => {
  const rows = await sequelize.query(
    `SELECT s.student_id AS "studentId", s.f_name AS "fName", s.l_name AS "lName" FROM "dbo"."Student" s
      WHERE lower(s.admission_no) = lower(:no) ${exceptStudentId != null ? "AND s.student_id <> :except" : ""}
      LIMIT 1`,
    { replacements: { no: admissionNo, except: exceptStudentId }, type: QueryTypes.SELECT, transaction }
  );
  return rows[0] || null;
};

// Take the next number. MUST run inside the transaction that creates the
// pupil: the counter row stays locked until it commits.
export const takeNextAdmissionNo = async (format, { transaction, date = new Date() } = {}) => {
  if (!transaction) throw new Error("takeNextAdmissionNo needs a transaction");
  const scope = admissionScope(format, date);
  const lockRow = () =>
    sequelize.query(`SELECT c.last_value AS "lastValue" FROM "dbo"."Admission_counter" c WHERE c.scope = :scope FOR UPDATE`, {
      replacements: { scope },
      type: QueryTypes.SELECT,
      transaction,
    });
  let [row] = await lockRow();
  if (!row) {
    const seed = await highestUsed(scope, transaction);
    await sequelize.query(
      `INSERT INTO "dbo"."Admission_counter" (scope, last_value, updated_at) VALUES (:scope, :seed, NOW()) ON CONFLICT (scope) DO NOTHING`,
      { replacements: { scope, seed }, type: QueryTypes.INSERT, transaction }
    );
    [row] = await lockRow();
  }
  let seq = Number(row?.lastValue) || 0;
  for (let i = 0; i < 1000; i += 1) {
    seq += 1;
    const candidate = renderAdmissionNo(format, seq, date);
    // A format saved before the width check (or a counter past 8 digits):
    // a clear 400 instead of a "value too long" database error.
    if (candidate.length > MAX_ADMISSION_NO) {
      throw new AppError(
        `The next admission number (${candidate}) would be longer than ${MAX_ADMISSION_NO} characters. Type one by hand or shorten the format in School settings.`,
        400
      );
    }
    if (!(await isTaken(candidate, { transaction }))) {
      await sequelize.query(`UPDATE "dbo"."Admission_counter" SET last_value = :seq, updated_at = NOW() WHERE scope = :scope`, {
        replacements: { seq, scope },
        type: QueryTypes.UPDATE,
        transaction,
      });
      return candidate;
    }
  }
  throw new AppError("Could not find a free admission number. Type one by hand.", 409);
};

// What the next number will probably be (for the form). Reserves nothing.
export const peekNextAdmissionNo = async (format, { date = new Date() } = {}) => {
  if (!format) return null;
  const scope = admissionScope(format, date);
  const [row] = await sequelize.query(`SELECT c.last_value AS "lastValue" FROM "dbo"."Admission_counter" c WHERE c.scope = :scope`, {
    replacements: { scope },
    type: QueryTypes.SELECT,
  });
  let seq = Math.max(Number(row?.lastValue) || 0, await highestUsed(scope));
  for (let i = 0; i < 1000; i += 1) {
    seq += 1;
    const candidate = renderAdmissionNo(format, seq, date);
    if (!(await isTaken(candidate))) return candidate;
  }
  return null;
};

// A typed admission number: trimmed, spaces collapsed; null when blank.
export const normaliseAdmissionNo = (input) => {
  if (input == null) return null;
  const value = String(input).replace(/\s+/g, " ").trim();
  if (!value) return null;
  if (value.length > MAX_ADMISSION_NO) throw new AppError(`An admission number can be at most ${MAX_ADMISSION_NO} characters`, 400);
  if (!/^[A-Za-z0-9/\-_. ]+$/.test(value)) {
    throw new AppError("An admission number can only use letters, numbers, spaces and / - _ .", 400);
  }
  return value;
};

export const assertAdmissionNoFree = async (admissionNo, opts = {}) => {
  const clash = await isTaken(admissionNo, opts);
  if (clash) {
    throw new AppError(
      `Admission number ${admissionNo} is already used by ${[clash.fName, clash.lName].filter(Boolean).join(" ") || "another pupil"}. Generate a new number or type a different one.`,
      409
    );
  }
};

// For a new pupil: the typed number (checked), else the next from the format,
// else none.
export const resolveNewAdmissionNo = async (typed, { format, transaction }) => {
  const value = normaliseAdmissionNo(typed);
  if (value) {
    await assertAdmissionNoFree(value, { transaction });
    return value;
  }
  return format ? takeNextAdmissionNo(format, { transaction }) : null;
};
