// AI-5: pluggable WhatsApp sender, built like the mailer (services/mailer.js).
// Nothing here runs at boot, so a missing setting never stops the API.
//
// WHATSAPP_DRIVER
//   log  (default)  write "would send" to the console, send nothing
//   cloud           Meta's WhatsApp Cloud API: plain text from the school's
//                   business number (WHATSAPP_TOKEN = a system-user access
//                   token, WHATSAPP_PHONE_NUMBER_ID = the sender number's id,
//                   optional WHATSAPP_API_VERSION, default v21.0)
//   off             do nothing at all
// cloud without WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID falls back to log
// (one warning), as does an unknown driver.
//
// Note: WhatsApp only delivers free-form text to someone who has messaged the
// business number in the last 24 hours. Outside that window Meta needs an
// approved message template; the API answers with an error, which is recorded
// as FAILED on the briefing (the in-app briefing is unaffected).
//
// sendWhatsApp() never throws: { status: SENT | LOGGED | FAILED | OFF, error? }.
// The error is a short reason, never the token. Numbers go to the provider
// only (never to the AI) and are masked in logs.
import axios from "axios";

const env = (k, d = "") => (process.env[k] === undefined ? d : String(process.env[k]).trim());
const MAX_TEXT = 4096; // the Cloud API's limit for a text body

const warned = new Set();
const warnOnce = (key, msg) => {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(msg);
};

/** Read on every call so tests (and a changed .env + restart) see new values. */
export const whatsappConfig = () => {
  const asked = env("WHATSAPP_DRIVER", "log").toLowerCase() || "log";
  const token = env("WHATSAPP_TOKEN");
  const phoneNumberId = env("WHATSAPP_PHONE_NUMBER_ID");
  let driver = asked;
  if (!["log", "cloud", "off"].includes(asked)) {
    warnOnce(`driver:${asked}`, `[whatsapp] Unknown WHATSAPP_DRIVER "${asked}": messages are logged, not sent.`);
    driver = "log";
  } else if (asked === "cloud" && (!token || !phoneNumberId)) {
    warnOnce("cloud-missing", "[whatsapp] WHATSAPP_DRIVER=cloud but WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID is missing: messages are logged, not sent.");
    driver = "log";
  }
  return {
    driver,
    token,
    phoneNumberId,
    apiVersion: env("WHATSAPP_API_VERSION", "v21.0") || "v21.0",
    timeoutMs: Math.max(1000, Number(env("WHATSAPP_TIMEOUT_MS", "15000")) || 15000),
  };
};

/**
 * A WhatsApp number in international form, digits only ("233241234567"), or
 * null. Ghana numbers may be written 024 123 4567, 0241234567, +233 24 123
 * 4567 or 233241234567; other countries need the + and country code.
 */
export const normalizeWhatsAppNumber = (raw) => {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  if (!/^\+?[\d\s()-]+$/.test(s)) return null;
  let digits = s.replace(/\D/g, "");
  if (s.startsWith("+")) {
    // international as written
  } else if (/^0[235]\d{8}$/.test(digits)) {
    digits = `233${digits.slice(1)}`;
  } else if (!/^233[235]\d{8}$/.test(digits)) {
    return null; // without a +, only Ghana numbers are understood
  }
  if (digits.startsWith("233") && !/^233[235]\d{8}$/.test(digits)) return null;
  return digits.length >= 10 && digits.length <= 15 ? digits : null;
};

/** "+233 24 *** **67" for logs and the screen. */
export const maskWhatsAppNumber = (n) => {
  const d = String(n ?? "").replace(/\D/g, "");
  if (d.length < 6) return "***";
  return `+${d.slice(0, 5)}***${d.slice(-2)}`;
};

const shortError = (e) => {
  const api = e?.response?.data?.error;
  const msg = api ? `${api.code ?? e.response.status} ${api.message || ""}` : e?.response?.status ? `HTTP ${e.response.status}` : e?.code || e?.message || e;
  return String(msg).replace(/\s+/g, " ").slice(0, 290);
};

/** Send (or log) one plain-text WhatsApp message. { to, text } -> { status, error?, id? }. */
export const sendWhatsApp = async ({ to, text }, cfg = whatsappConfig()) => {
  try {
    const number = normalizeWhatsAppNumber(to);
    if (!number) return { status: "FAILED", error: "Not a valid WhatsApp number" };
    if (cfg.driver === "off") return { status: "OFF" };
    const body = String(text ?? "").slice(0, MAX_TEXT);
    if (!body.trim()) return { status: "FAILED", error: "Nothing to send" };
    if (cfg.driver === "log") {
      console.log(`[whatsapp] not sent (WHATSAPP_DRIVER=log): to=${maskWhatsAppNumber(number)} text="${body.slice(0, 80).replace(/\s+/g, " ")}"`);
      return { status: "LOGGED" };
    }
    const url = `https://graph.facebook.com/${encodeURIComponent(cfg.apiVersion)}/${encodeURIComponent(cfg.phoneNumberId)}/messages`;
    const res = await axios.post(
      url,
      { messaging_product: "whatsapp", recipient_type: "individual", to: number, type: "text", text: { preview_url: false, body } },
      { headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" }, timeout: cfg.timeoutMs }
    );
    return { status: "SENT", id: res?.data?.messages?.[0]?.id ?? null };
  } catch (e) {
    return { status: "FAILED", error: shortError(e) };
  }
};

// For tests.
export const __resetWhatsApp = () => warned.clear();
