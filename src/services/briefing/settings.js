// AI-5: when the briefing is made and where it goes (Ai_briefing_settings,
// one row). A database without migration 046 reads as the defaults.
import { AiBriefingSettings } from "../../models/index.js";
import { AppError } from "../../utils/errorHandling.js";
import { round2, toNum } from "../../utils/money.js";
import { isEmail, mailConfig, maskEmail } from "../mailer.js";
import { maskWhatsAppNumber, normalizeWhatsAppNumber, whatsappConfig } from "../whatsapp.js";
import { BRIEFING_TZ, TIME_RE, cleanDays, describeSchedule } from "./schedule.js";

export const DEFAULT_BRIEFING_SETTINGS = Object.freeze({
  days: [1],
  runTime: "06:00",
  owingThresholdGhs: 100,
  emailEnabled: false,
  emailTo: null,
  whatsappEnabled: false,
  whatsappTo: null,
});
const MAX_OWING_LINE = 1_000_000;

const missingTable = (e) => (e?.original?.code || e?.parent?.code) === "42P01";

/** The row merged over the defaults. */
export const getBriefingSettings = async () => {
  let row = null;
  try {
    row = await AiBriefingSettings.findOne({ where: { briefingSettingsId: 1 }, raw: true });
  } catch (e) {
    if (!missingTable(e)) throw e; // migration 046 not applied yet
  }
  const d = DEFAULT_BRIEFING_SETTINGS;
  return {
    days: row ? cleanDays(row.days) : [...d.days],
    runTime: row && TIME_RE.test(String(row.runTime)) ? row.runTime : d.runTime,
    owingThresholdGhs: row?.owingThresholdGhs !== undefined && row?.owingThresholdGhs !== null ? round2(toNum(row.owingThresholdGhs)) : d.owingThresholdGhs,
    emailEnabled: Boolean(row?.emailEnabled),
    emailTo: row?.emailTo || null,
    whatsappEnabled: Boolean(row?.whatsappEnabled),
    whatsappTo: row?.whatsappTo || null,
    updatedBy: row?.updatedBy || null,
    updatedAt: row?.updatedAt || null,
    tableMissing: !row,
  };
};

/** Settings plus what the page needs to explain them (drivers, schedule in words). */
export const settingsView = (s) => ({
  ...s,
  timeZone: BRIEFING_TZ,
  schedule: describeSchedule(s),
  channels: {
    email: { driver: mailConfig().driver, to: s.emailTo, masked: s.emailTo ? maskEmail(s.emailTo) : null },
    whatsapp: { driver: whatsappConfig().driver, to: s.whatsappTo ? `+${s.whatsappTo}` : null, masked: s.whatsappTo ? maskWhatsAppNumber(s.whatsappTo) : null },
  },
});

const bool = (v, label) => {
  if (typeof v !== "boolean") throw new AppError(`${label} must be on or off.`, 400);
  return v;
};

/**
 * PUT: any of { days, runTime, owingThresholdGhs, emailEnabled, emailTo,
 * whatsappEnabled, whatsappTo }; missing keys keep their saved value. A channel
 * can only be on with a valid address / number. Clearing the address switches
 * the channel off.
 */
export const updateBriefingSettings = async (body = {}, { username = null } = {}) => {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppError("Nothing to save.", 400);
  const current = await getBriefingSettings();
  const next = { ...current };

  if (body.days !== undefined) {
    if (!Array.isArray(body.days) || body.days.some((d) => !Number.isInteger(Number(d)) || Number(d) < 1 || Number(d) > 7)) {
      throw new AppError("Days must be weekdays 1 (Monday) to 7 (Sunday).", 400);
    }
    next.days = cleanDays(body.days);
  }
  if (body.runTime !== undefined) {
    const t = String(body.runTime ?? "").trim();
    if (!TIME_RE.test(t)) throw new AppError("The time must be HH:MM, e.g. 06:00.", 400);
    next.runTime = t;
  }
  if (body.owingThresholdGhs !== undefined) {
    const n = Number(body.owingThresholdGhs);
    if (body.owingThresholdGhs === null || body.owingThresholdGhs === "" || !Number.isFinite(n) || n < 1 || n > MAX_OWING_LINE || round2(n) !== n) {
      throw new AppError("The owing line must be an amount in GH₵ of at least 1.", 400);
    }
    next.owingThresholdGhs = n;
  }
  if (body.emailTo !== undefined) {
    const e = String(body.emailTo ?? "").trim();
    if (e && !isEmail(e)) throw new AppError("That email address doesn't look right.", 400);
    next.emailTo = e || null;
  }
  if (body.whatsappTo !== undefined) {
    const raw = String(body.whatsappTo ?? "").trim();
    const n = raw ? normalizeWhatsAppNumber(raw) : null;
    if (raw && !n) throw new AppError("That WhatsApp number doesn't look right. Use 024 123 4567, or +<country code> for a number outside Ghana.", 400);
    next.whatsappTo = n;
  }
  if (body.emailEnabled !== undefined) next.emailEnabled = bool(body.emailEnabled, "Email");
  if (body.whatsappEnabled !== undefined) next.whatsappEnabled = bool(body.whatsappEnabled, "WhatsApp");
  if (next.emailEnabled && !next.emailTo) {
    if (body.emailEnabled === true) throw new AppError("Enter the head teacher's email address to send the briefing by email.", 400);
    next.emailEnabled = false;
  }
  if (next.whatsappEnabled && !next.whatsappTo) {
    if (body.whatsappEnabled === true) throw new AppError("Enter the head teacher's WhatsApp number to send the briefing on WhatsApp.", 400);
    next.whatsappEnabled = false;
  }

  try {
    await AiBriefingSettings.upsert({
      briefingSettingsId: 1,
      days: next.days,
      runTime: next.runTime,
      owingThresholdGhs: next.owingThresholdGhs,
      emailEnabled: next.emailEnabled,
      emailTo: next.emailTo,
      whatsappEnabled: next.whatsappEnabled,
      whatsappTo: next.whatsappTo,
      updatedBy: username ? String(username).slice(0, 100) : null,
      updatedAt: new Date(),
    });
  } catch (e) {
    if (missingTable(e)) throw new AppError("The briefing settings table is missing: run the database migrations (046) first.", 503);
    throw e;
  }
  return getBriefingSettings();
};
