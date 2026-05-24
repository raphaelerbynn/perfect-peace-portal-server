import crypto from "crypto";
import bcrypt from "bcrypt";
import { Op } from "sequelize";
import { PasswordResetCode } from "../models/index.js";
import { AppError } from "../utils/errorHandling.js";

// ---------------------------------------------------------------------------
// Unified, secure reset-code mechanism shared by BOTH password-reset flows:
//   - admin-portal OTP flow  (services/auth.js controllers)
//   - parent-app PIN flow    (generalController PIN endpoints)
//
// Properties:
//   - Codes are generated with crypto.randomInt (CSPRNG), exactly 6 digits.
//   - Only the bcrypt hash is persisted — never plaintext, never in a JWT.
//   - On verify: load the latest non-consumed, non-expired code for the user,
//     bcrypt.compare, increment attempts, lock after MAX_ATTEMPTS, single-use
//     on success. Expiry enforced server-side (no per-process timers/GC).
//   - Resend protection: a per-user cooldown between sends + a daily cap,
//     independent of the IP rate limiter.
// ---------------------------------------------------------------------------

const BCRYPT_ROUNDS = 10;
const CODE_LENGTH = 6;

// Tunables (also documented in the task report).
export const CODE_TTL_MS = 30 * 60 * 1000;     // codes valid for 30 minutes
export const MAX_ATTEMPTS = 5;                  // wrong tries before lock-out
export const RESEND_COOLDOWN_MS = 45 * 1000;    // min gap between sends per user
export const DAILY_SEND_CAP = 5;                // max sends per user per 24h

// 6-digit numeric code using a CSPRNG. randomInt's upper bound is exclusive.
const generateNumericCode = () => {
  const max = 10 ** CODE_LENGTH; // 1_000_000 -> 000000..999999
  return crypto.randomInt(0, max).toString().padStart(CODE_LENGTH, "0");
};

// Enforce resend protection BEFORE generating/sending a new code. Throws an
// AppError(429) when the per-user cooldown or daily cap is exceeded.
const enforceResendLimits = async ({ identifier, userType }) => {
  const now = Date.now();

  const latest = await PasswordResetCode.findOne({
    where: { identifier, userType },
    order: [["created_at", "DESC"]],
  });

  if (latest) {
    const createdMs = new Date(latest.get("created_at")).getTime();
    if (now - createdMs < RESEND_COOLDOWN_MS) {
      const wait = Math.ceil((RESEND_COOLDOWN_MS - (now - createdMs)) / 1000);
      throw new AppError(
        `Please wait ${wait}s before requesting another code.`,
        429
      );
    }
  }

  const since = new Date(now - 24 * 60 * 60 * 1000);
  const sentToday = await PasswordResetCode.count({
    where: { identifier, userType, created_at: { [Op.gte]: since } },
  });
  if (sentToday >= DAILY_SEND_CAP) {
    throw new AppError(
      "Daily reset-code limit reached. Please try again tomorrow.",
      429
    );
  }
};

// Generate + persist a fresh code for the user and return the PLAINTEXT code so
// the caller can SMS it. The plaintext is never stored. Any prior outstanding
// (non-consumed) codes for this user are invalidated so only the newest works.
const issueResetCode = async ({ identifier, userType }) => {
  await enforceResendLimits({ identifier, userType });

  // Invalidate older outstanding codes for this user (defence in depth — verify
  // only looks at the latest anyway, but this keeps the table tidy & safe).
  await PasswordResetCode.update(
    { consumed: true },
    { where: { identifier, userType, consumed: false } }
  );

  const code = generateNumericCode();
  const codeHash = await bcrypt.hash(code, BCRYPT_ROUNDS);

  await PasswordResetCode.create({
    identifier: String(identifier),
    userType,
    codeHash,
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
    attempts: 0,
    consumed: false,
  });

  return code;
};

// Verify a supplied code against the latest outstanding record for the user.
// Returns true on a match, false for any failure (no record, expired, locked,
// mismatch). Wrong attempts increment `attempts` and lock the record after
// MAX_ATTEMPTS. Does NOT throw on a normal "wrong code" so callers can decide
// how to respond (the PIN flow returns { valid:false }).
//
// `consume` controls single-use semantics:
//   - true  (default): a successful match burns the code (admin reset, parent
//            /update-pin — the password-changing step).
//   - false: a non-destructive "peek" used by the parent-app /verify-pin step,
//            which is followed by a separate /update-pin call that re-verifies
//            and consumes. Failed attempts are still counted/locked either way.
const verifyResetCode = async ({ identifier, userType, code, consume = true }) => {
  if (!code || typeof code !== "string") {
    return false;
  }

  const record = await PasswordResetCode.findOne({
    where: { identifier: String(identifier), userType, consumed: false },
    order: [["created_at", "DESC"]],
  });

  if (!record) {
    return false;
  }

  // Server-side expiry enforcement (replaces the old per-process setInterval GC).
  if (new Date(record.expiresAt).getTime() < Date.now()) {
    record.consumed = true;
    await record.save();
    return false;
  }

  // Lock-out after too many wrong attempts.
  if (record.attempts >= MAX_ATTEMPTS) {
    record.consumed = true;
    await record.save();
    return false;
  }

  const matches = await bcrypt.compare(code, record.codeHash);
  if (!matches) {
    record.attempts += 1;
    if (record.attempts >= MAX_ATTEMPTS) {
      record.consumed = true; // burn the code after the 5th failed attempt
    }
    await record.save();
    return false;
  }

  // Success: burn it unless this is a non-destructive peek.
  if (consume) {
    record.consumed = true;
    await record.save();
  }
  return true;
};

export { issueResetCode, verifyResetCode, generateNumericCode };
