import { AppError } from "./errorHandling.js";

// Lightweight, dependency-free validation helpers. Throw AppError(400) on bad
// input so the central errorHandler returns a clean 400 instead of a TypeError
// turning into a 500.

const PORTAL_ROLES = ["STU", "STAFF"];
const PASSWORD_MIN_LENGTH = 8;
// Pragmatic email check — not RFC-perfect, just enough to reject obvious junk.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Parse + validate a portal index number of the form `ROLE/ID` where ROLE is
// one of STU|STAFF and ID is a non-empty token. Returns { role, id }.
// (BE-A6) Replaces the old `indexNumber.split("/")` that threw a TypeError on
// missing/malformed input.
const parseIndexNumber = (indexNumber) => {
  if (!indexNumber || typeof indexNumber !== "string") {
    throw new AppError("Index number is required.", 400);
  }
  const parts = indexNumber.split("/");
  if (parts.length !== 2) {
    throw new AppError("Invalid index number format. Expected ROLE/ID.", 400);
  }
  const [role, id] = parts;
  if (!PORTAL_ROLES.includes(role)) {
    throw new AppError("Invalid index number role.", 400);
  }
  if (!id || !id.trim()) {
    throw new AppError("Invalid index number id.", 400);
  }
  return { role, id: id.trim() };
};

const assertRequiredString = (value, fieldLabel) => {
  if (typeof value !== "string" || !value.trim()) {
    throw new AppError(`${fieldLabel} is required.`, 400);
  }
};

const assertPassword = (password) => {
  if (typeof password !== "string" || password.length < PASSWORD_MIN_LENGTH) {
    throw new AppError(
      `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`,
      400
    );
  }
};

const assertEmail = (email) => {
  // Email is optional in places; only validate shape when a value is present.
  if (email === undefined || email === null || email === "") {
    return;
  }
  if (typeof email !== "string" || !EMAIL_RE.test(email)) {
    throw new AppError("A valid email address is required.", 400);
  }
};

export {
  parseIndexNumber,
  assertRequiredString,
  assertPassword,
  assertEmail,
  PORTAL_ROLES,
  PASSWORD_MIN_LENGTH,
};
