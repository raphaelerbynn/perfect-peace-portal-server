// B18: school identity and branding (School_settings, one row).
//
// Until the office changes anything, every value is what the apps printed
// before B18 (DEFAULTS, and the row migration 034 inserts). Colours left empty
// mean "the built-in theme"; no logo means "the built-in crest".
// GET /school is public (the sign-in screens show the name and logo), so it
// returns display fields only.
import crypto from "crypto";
import sequelize from "../config/database.js";
import { SchoolSettings } from "../models/index.js";
import { AppError } from "../utils/errorHandling.js";
import { DEFAULT_ADMISSION_FORMAT, parseAdmissionFormat, peekNextAdmissionNo, renderAdmissionNo } from "./admission.js";
import { saveUpload, storage } from "./storage.js";

export const DEFAULTS = Object.freeze({
  name: "PERFECT PEACE PREPARATORY SCHOOL",
  shortName: "Perfect Peace",
  motto: null,
  addressLines: "P.O. BOX 13\nMEMPEASEM/ESSAMAN",
  email: "perfectpeacepreparatoryschool@gmail.com",
  phones: "024 233 2420/024 315 4072",
  logoKey: null,
  primaryColor: null,
  accentColor: null,
  admissionFormat: DEFAULT_ADMISSION_FORMAT,
  reportCardFooter: null,
  receiptFooter: null,
  updatedBy: null,
  updatedAt: null,
});

const CACHE_MS = 60 * 1000;
let cache = null; // { at, value }
export const clearSchoolCache = () => {
  cache = null;
};

// The settings row merged over the defaults. A database that hasn't had
// migration 034 yet still gets today's values (no 500 on the sign-in page),
// but no automatic admission numbers.
export const getSchoolSettings = async ({ fresh = false } = {}) => {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  let row = null;
  try {
    row = await SchoolSettings.findOne({ where: { schoolSettingsId: 1 }, raw: true });
  } catch (e) {
    const code = e?.original?.code || e?.parent?.code;
    if (code !== "42P01") throw e; // undefined_table: migration not applied yet
  }
  const value = { ...DEFAULTS };
  if (row) {
    for (const k of Object.keys(DEFAULTS)) if (row[k] !== undefined) value[k] = row[k];
  } else {
    value.admissionFormat = null;
  }
  cache = { at: Date.now(), value };
  return value;
};

const logoVersion = (key) => crypto.createHash("sha256").update(String(key)).digest("hex").slice(0, 12);

// What anyone (even signed out) may see. Never the storage key.
export const toPublicSchool = (s) => ({
  name: s.name,
  shortName: s.shortName || s.name,
  motto: s.motto || null,
  addressLines: String(s.addressLines || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean),
  email: s.email || null,
  phones: s.phones || null,
  primaryColor: s.primaryColor || null,
  accentColor: s.accentColor || null,
  reportCardFooter: s.reportCardFooter || null,
  receiptFooter: s.receiptFooter || null,
  logoUrl: s.logoKey ? `/school/logo?v=${logoVersion(s.logoKey)}` : null,
});

export const getPublicSchool = async () => toPublicSchool(await getSchoolSettings());

// For the Settings page (Administrator): public fields + the admission format.
export const getSchoolSettingsForAdmin = async () => {
  const s = await getSchoolSettings({ fresh: true });
  return {
    ...toPublicSchool(s),
    admissionFormat: s.admissionFormat || "",
    nextAdmissionNo: s.admissionFormat ? await peekNextAdmissionNo(s.admissionFormat) : null,
    updatedBy: s.updatedBy || null,
    updatedAt: s.updatedAt || null,
  };
};

// "#abc" / "#AABBCC" -> "#aabbcc"; blank -> null (built-in theme).
export const normaliseColor = (input, label = "Colour") => {
  if (input == null) return null;
  const v = String(input).trim();
  if (!v) return null;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (!m) throw new AppError(`${label} must be a colour like #1e6b3a`, 400);
  const hex = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  return `#${hex.toLowerCase()}`;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const text = (v, label, max, { required = false } = {}) => {
  // eslint-disable-next-line no-control-regex
  const s = String(v ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
  if (required && !s) throw new AppError(`${label} is required`, 400);
  if (s.length > max) throw new AppError(`${label} can be at most ${max} characters`, 400);
  return s || null;
};

// Validate a (partial) update. Only fields present in the body change.
export const validateSchoolUpdate = (body = {}) => {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body || {}, k);
  if (has("name")) {
    out.name = text(body.name, "School name", 100, { required: true });
    if (out.name.length < 2) throw new AppError("School name is too short", 400);
  }
  if (has("shortName")) out.shortName = text(body.shortName, "Short name", 40);
  if (has("motto")) out.motto = text(body.motto, "Motto", 150);
  if (has("addressLines")) {
    const raw = Array.isArray(body.addressLines) ? body.addressLines : String(body.addressLines ?? "").split("\n");
    const lines = raw.map((l) => text(l, "Address line", 80)).filter(Boolean);
    if (lines.length > 4) throw new AppError("The address can have at most 4 lines", 400);
    out.addressLines = lines.join("\n") || null;
  }
  if (has("email")) {
    out.email = text(body.email, "Email", 100);
    if (out.email && !EMAIL_RE.test(out.email)) throw new AppError("Email is invalid", 400);
  }
  if (has("phones")) out.phones = text(body.phones, "Phone numbers", 80);
  if (has("primaryColor")) out.primaryColor = normaliseColor(body.primaryColor, "Main colour");
  if (has("accentColor")) out.accentColor = normaliseColor(body.accentColor, "Accent colour");
  if (has("admissionFormat")) out.admissionFormat = parseAdmissionFormat(body.admissionFormat);
  if (has("reportCardFooter")) out.reportCardFooter = text(body.reportCardFooter, "Report card footer", 300);
  if (has("receiptFooter")) out.receiptFooter = text(body.receiptFooter, "Receipt footer", 300);
  return out;
};

// Write the row (create it with today's values if migration 034's insert is
// missing), locked so two saves don't interleave. Returns the previous row.
const writeSettings = async (changes, username, transaction) => {
  const row = await SchoolSettings.findOne({
    where: { schoolSettingsId: 1 },
    transaction,
    lock: transaction?.LOCK?.UPDATE,
  });
  const stamp = { updatedBy: username ? String(username).slice(0, 100) : null, updatedAt: new Date() };
  if (!row) {
    // eslint-disable-next-line no-unused-vars
    const { updatedAt, updatedBy, ...base } = DEFAULTS;
    await SchoolSettings.create({ schoolSettingsId: 1, ...base, ...changes, ...stamp }, { transaction });
    return null;
  }
  const previous = typeof row.get === "function" ? row.get({ plain: true }) : row;
  await SchoolSettings.update({ ...changes, ...stamp }, { where: { schoolSettingsId: 1 }, transaction });
  return previous;
};

export const updateSchoolSettings = async (body, { username } = {}) => {
  const changes = validateSchoolUpdate(body);
  if (!Object.keys(changes).length) throw new AppError("Nothing to save", 400);
  await sequelize.transaction((t) => writeSettings(changes, username, t));
  clearSchoolCache();
  return getSchoolSettingsForAdmin();
};

// New logo: save the file, point the settings at it, then remove the old one.
export const setSchoolLogo = async (file, { username } = {}) => {
  const saved = await saveUpload(file, "logo");
  let previous;
  try {
    previous = await sequelize.transaction((t) => writeSettings({ logoKey: saved.key }, username, t));
  } catch (e) {
    await storage.remove(saved.key);
    throw e;
  }
  clearSchoolCache();
  if (previous?.logoKey && previous.logoKey !== saved.key) await storage.remove(previous.logoKey);
  return getPublicSchool();
};

// Back to the built-in crest.
export const removeSchoolLogo = async ({ username } = {}) => {
  const previous = await sequelize.transaction((t) => writeSettings({ logoKey: null }, username, t));
  clearSchoolCache();
  if (previous?.logoKey) await storage.remove(previous.logoKey);
  return getPublicSchool();
};

export const getSchoolLogoKey = async () => {
  const s = await getSchoolSettings();
  if (!s.logoKey) throw new AppError("No logo uploaded", 404);
  return s.logoKey;
};

// Preview for the Settings page: what numbers a format being typed gives.
export const previewAdmissionFormat = async (input) => {
  const format = parseAdmissionFormat(input);
  if (!format) return { format: "", example: null, next: null };
  return { format, example: renderAdmissionNo(format, 1), next: await peekNextAdmissionNo(format) };
};

// The next admission number for the Add student form (reserves nothing).
export const getNextAdmissionNoSuggestion = async () => {
  const s = await getSchoolSettings({ fresh: true });
  return { admissionNo: s.admissionFormat ? await peekNextAdmissionNo(s.admissionFormat) : null, format: s.admissionFormat || "" };
};
