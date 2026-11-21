// B16: pluggable mailer. Nothing here runs at boot, so a missing or wrong
// email setting can never stop the API from starting.
//
// EMAIL_DRIVER
//   log  (default)  write "would send" to the console, send nothing
//   smtp            send through SMTP_HOST (e.g. a Gmail account with an app
//                   password: smtp.gmail.com, 465 = TLS, 587 = STARTTLS)
//   off             do nothing at all
// An smtp driver without SMTP_HOST / SMTP_USER / SMTP_PASS falls back to log
// (one warning), as does an unknown driver.
//
// sendMail() never throws: it returns { status: SENT | LOGGED | FAILED | OFF,
// error? }. The error is a short reason, never the password.

const env = (k, d = "") => (process.env[k] === undefined ? d : String(process.env[k]).trim());

export const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
export const isEmail = (s) => typeof s === "string" && s.length <= 254 && EMAIL_RE.test(s.trim());

// "j***@gmail.com" for logs.
export const maskEmail = (s) => {
  const [user = "", domain = ""] = String(s || "").split("@");
  return `${user.slice(0, 1)}***@${domain}`;
};

const warned = new Set();
const warnOnce = (key, msg) => {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(msg);
};

// Read on every call so tests (and a changed .env + restart) see new values.
export const mailConfig = () => {
  const asked = env("EMAIL_DRIVER", "log").toLowerCase() || "log";
  const port = Number(env("SMTP_PORT", "587")) || 587;
  const secureEnv = env("SMTP_SECURE").toLowerCase();
  const secure = secureEnv ? secureEnv === "true" : port === 465;
  const smtp = {
    host: env("SMTP_HOST"),
    port,
    secure,
    user: env("SMTP_USER"),
    pass: env("SMTP_PASS"),
  };
  const fromAddress = env("EMAIL_FROM") || env("SMTP_FROM") || smtp.user;
  const fromName = env("EMAIL_FROM_NAME");
  let driver = asked;
  if (!["log", "smtp", "off"].includes(asked)) {
    warnOnce(`driver:${asked}`, `[mail] Unknown EMAIL_DRIVER "${asked}": emails are logged, not sent.`);
    driver = "log";
  } else if (asked === "smtp" && (!smtp.host || !smtp.user || !smtp.pass || !isEmail(fromAddress))) {
    warnOnce("smtp-missing", "[mail] EMAIL_DRIVER=smtp but SMTP_HOST / SMTP_USER / SMTP_PASS / EMAIL_FROM is missing: emails are logged, not sent.");
    driver = "log";
  }
  return {
    driver,
    smtp,
    fromAddress,
    fromName,
    // Gmail allows about 500 a day; stay under it by default.
    dailyLimit: Math.max(0, Number(env("EMAIL_DAILY_LIMIT", "450")) || 0),
    batchSize: Math.max(1, Number(env("EMAIL_BATCH_SIZE", "20")) || 20),
    batchPauseMs: Math.max(0, Number(env("EMAIL_BATCH_PAUSE_MS", "2000")) || 0),
  };
};

// "Name" <address>, with the name's quotes removed.
export const fromHeader = ({ fromAddress, fromName }) =>
  fromName ? `"${fromName.replace(/["\r\n\\]/g, "")}" <${fromAddress}>` : fromAddress;

let transport = null; // { key, t }
const getTransport = async (cfg) => {
  const key = JSON.stringify(cfg.smtp);
  if (transport?.key === key) return transport.t;
  const nodemailer = (await import("nodemailer")).default;
  const t = nodemailer.createTransport({
    host: cfg.smtp.host,
    port: cfg.smtp.port,
    secure: cfg.smtp.secure, // 465: TLS from the start
    requireTLS: !cfg.smtp.secure, // 587: insist on STARTTLS, never plain text
    auth: { user: cfg.smtp.user, pass: cfg.smtp.pass },
    pool: true,
    maxConnections: 1,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });
  transport = { key, t };
  return t;
};

// For tests.
export const __resetMailer = () => {
  transport = null;
  warned.clear();
};

const shortError = (e) => String(e?.responseCode ? `${e.responseCode} ${e.response || e.message}` : e?.code || e?.message || e).replace(/\s+/g, " ").slice(0, 290);

/**
 * Send (or log) one email. { to, subject, text, html } -> { status, error? }.
 */
export const sendMail = async ({ to, subject, text, html }, cfg = mailConfig()) => {
  try {
    if (!isEmail(to)) return { status: "FAILED", error: "Not a valid email address" };
    if (cfg.driver === "off") return { status: "OFF" };
    if (cfg.driver === "log") {
      console.log(`[mail] not sent (EMAIL_DRIVER=log): to=${maskEmail(to)} subject="${String(subject).slice(0, 80)}"`);
      return { status: "LOGGED" };
    }
    const t = await getTransport(cfg);
    await t.sendMail({ from: fromHeader(cfg), to: to.trim(), subject, text, html });
    return { status: "SENT" };
  } catch (e) {
    return { status: "FAILED", error: shortError(e) };
  }
};
