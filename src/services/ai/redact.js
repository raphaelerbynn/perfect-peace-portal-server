// AI-0: the last thing that touches data before it becomes prompt text
// (ported from SchoolPro's ai-redact.ts, reduced to PP's tables).
//
// The defence against the model repeating a parent's phone number is that the
// number is never sent, not a sentence in the prompt. So:
//   redactForAi(value)  walks any object/array and DROPS credential, contact
//                       and staff-identity keys (password, contact, contact1,
//                       phone, email, address, ssnitNumber, accountNumber...),
//                       then scrubs phone numbers / emails out of every string.
//   redactText(text)    replaces phone numbers and email addresses in free
//                       text with [phone] / [email].
// run.js applies redactText to every message it sends, whatever the feature,
// so a question typed with a phone number in it is scrubbed too. There is no
// opt-out: no AI feature in this school needs contact data.
// Neither function mutates its input.

const norm = (key) => String(key).toLowerCase().replace(/[_\-\s]/g, "");

// Credentials and secrets, matched exactly or by suffix (not substring, so
// "inputTokens" survives while "refreshToken" does not).
const CREDENTIAL_KEYS = new Set([
  "password",
  "passwordhash",
  "pwd",
  "pin",
  "otp",
  "secret",
  "token",
  "jwt",
  "authorization",
  "apikey",
  "resetcode",
  "verificationcode",
]);
const CREDENTIAL_SUFFIXES = ["password", "passwordhash", "secret", "apikey", "privatekey", "accesstoken", "refreshtoken", "authtoken", "resettoken"];

// Contact details (Parent.contact/contact1/email, Teacher.phone/email/address,
// Student.address, UserAccount.email, School phones...).
const CONTACT_KEYS = new Set([
  "contact",
  "contact1",
  "contact2",
  "contacts",
  "phone",
  "phones",
  "phonenumber",
  "mobile",
  "telephone",
  "whatsapp",
  "email",
  "emailaddress",
  "parentemail",
  "parentcontact",
  "parentphone",
  "guardiancontact",
  "guardianphone",
  "guardianemail",
  "toaddress", // Email_log
  "address",
  "addresslines",
  "homeaddress",
  "residence",
  "references", // Teacher / UserAccount referee details
]);

// Staff identity and bank details: never needed by any AI feature.
const STAFF_PRIVATE_KEYS = new Set(["ssnitnumber", "tinnumber", "bank", "accountnumber", "photokey", "photothumbkey", "logokey"]);

export const isRedactedKey = (key) => {
  const k = norm(key);
  return (
    CREDENTIAL_KEYS.has(k) ||
    CREDENTIAL_SUFFIXES.some((s) => k.endsWith(s)) ||
    CONTACT_KEYS.has(k) ||
    STAFF_PRIVATE_KEYS.has(k)
  );
};

// Emails, Ghana numbers (024 233 2420, 0242332420, +233 24 233 2420, 233-24-...)
// and other international numbers written with a +. Kept narrow so amounts,
// dates, index numbers (STU/123) and admission numbers (PPS/2026/0001) survive.
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const GH_PHONE_RE = /(?<!\d)(?:\+?233[\s-]?|0)[235]\d(?:[\s-]?\d){7}(?!\d)/g;
const INTL_PHONE_RE = /(?<![\w/])\+\d{1,3}(?:[\s-]?\d){6,12}(?!\d)/g;

export const redactText = (text) => {
  if (typeof text !== "string" || !text) return text;
  return text.replace(EMAIL_RE, "[email]").replace(GH_PHONE_RE, "[phone]").replace(INTL_PHONE_RE, "[phone]");
};

const isPlainObject = (v) => {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

const MAX_DEPTH = 12;

const walk = (value, depth, path) => {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactText(value);
  if (depth > MAX_DEPTH) return undefined;
  // Sequelize instances: use their plain values.
  if (value && typeof value.get === "function" && value.dataValues && !isPlainObject(value)) {
    return walk(value.get({ plain: true }), depth, path);
  }
  if (Array.isArray(value)) {
    if (path.has(value)) return undefined;
    path.add(value);
    const out = value.map((item) => walk(item, depth + 1, path));
    path.delete(value);
    return out;
  }
  if (!isPlainObject(value)) return value; // Date, number, boolean, Buffer...
  if (path.has(value)) return undefined;
  path.add(value);
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined || isRedactedKey(key)) continue;
    const r = walk(child, depth + 1, path);
    if (r !== undefined) out[key] = r;
  }
  path.delete(value);
  return out;
};

/** A copy of `value` safe to put in a prompt (or a tool result). */
export const redactForAi = (value) => walk(value, 0, new Set());

/** Dotted paths redactForAi would drop, for tests and debugging. */
export const redactedPaths = (value, prefix = "") => {
  const paths = [];
  if (Array.isArray(value)) {
    value.forEach((v, i) => paths.push(...redactedPaths(v, `${prefix}[${i}]`)));
  } else if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      const p = prefix ? `${prefix}.${key}` : key;
      if (isRedactedKey(key)) paths.push(p);
      else paths.push(...redactedPaths(child, p));
    }
  }
  return paths;
};
