// B16: in-app + email notifications.
//
// notify() is the one entry point for business code. It NEVER throws and never
// makes the business action fail: the in-app rows are written after the
// action has committed, emails go out in the background.
//
// Recipients: { type: STUDENT | STAFF | OFFICE, id }. Parents use the pupil's
// login, so a STUDENT notification is the family's; its email goes to the
// pupil's parent (Parent.email). STAFF = a teacher's portal login (Teacher.email),
// OFFICE = an office login by username (User_account.email).
//
// Each type has a switch for in-app and for email (Notification_setting,
// Administrator). SMS stays where it was (fee / attendance / payroll SMS).
import { Op } from "sequelize";
import {
  Class,
  EmailLog,
  Invoice,
  NotificationSetting,
  Parent,
  Student,
  StudentMarks,
  Subject,
  Teacher,
  TeachingAssignment,
  Term,
  UserAccount,
  UserNotification,
} from "../models/index.js";
import { AppError } from "../utils/errorHandling.js";
import { formatGhs } from "../utils/money.js";
import { renderNotificationEmail } from "../utils/emailTemplate.js";
import { isEmail, mailConfig, sendMail } from "./mailer.js";
import { getSchoolSettings } from "./school.js";
import { getCompleteness } from "./reportCards.js";
import { isKgSection } from "./teacherScope.js";

// ------------------------------------------------------------------ types
// Defaults = migration 040's seed rows. A type added later (e.g. B14's
// INVOICE_ISSUED) only needs an entry here; without a row it uses these.
// inAppLocked: the in-app row is also the "already sent?" record (absence
// once a day, results / reminder cooldown), so only its email can be switched
// off. priority: not held back by EMAIL_DAILY_LIMIT (a security notice must
// still reach the owner on a busy day).
export const TYPES = Object.freeze({
  NEWS_POST: { label: "New news post or event", who: "Pupils, teachers and office (the post's audience)", inApp: true, email: false },
  PAYMENT_RECORDED: { label: "Fee payment recorded", who: "The pupil's login / parent", inApp: true, email: true },
  RESULTS_READY: { label: "Results / report card ready", who: "Pupils of the class / parents", inApp: true, email: true, inAppLocked: true },
  ATTENDANCE_ABSENT: { label: "Pupil marked absent", who: "The pupil's login / parent", inApp: true, email: false, inAppLocked: true },
  PASSWORD_CHANGED: { label: "Password changed", who: "The person whose password changed", inApp: true, email: true, priority: true },
  SCORES_MISSING: { label: "Scores missing reminder", who: "Teachers with missing scores", inApp: true, email: false, inAppLocked: true },
  INVOICE_ISSUED: { label: "Invoice issued", who: "The pupil's login / parent", inApp: true, email: false },
  // AI-5: the head teacher's own email / WhatsApp copy is sent by the briefing itself (its settings).
  AI_BRIEFING: { label: "Monday briefing ready", who: "Administrators", inApp: true, email: false },
});
export const RECIPIENT_TYPES = ["STUDENT", "STAFF", "OFFICE"];
const CHUNK = 500;
const LIST_DEFAULT = 20;
const LIST_MAX = 100;

const log = (msg, e) => console.error(`[notify] ${msg}: ${e?.message || e}`);
const clip = (s, n) => (s == null ? null : String(s).slice(0, n));

// ------------------------------------------------------------------ settings
const SETTINGS_MS = 60 * 1000;
let settingsCache = null; // { at, map }
export const clearNotifySettingsCache = () => {
  settingsCache = null;
};

export const getTypeSettings = async () => {
  if (settingsCache && Date.now() - settingsCache.at < SETTINGS_MS) return settingsCache.map;
  const map = {};
  for (const [type, t] of Object.entries(TYPES)) map[type] = { inApp: t.inApp, email: t.email };
  try {
    const rows = await NotificationSetting.findAll({ raw: true });
    for (const r of rows) if (map[r.type]) map[r.type] = { inApp: !!r.inApp || !!TYPES[r.type].inAppLocked, email: !!r.email };
  } catch (e) {
    log("settings unavailable, using defaults", e); // a database without 040 yet
  }
  settingsCache = { at: Date.now(), map };
  return map;
};

// ------------------------------------------------------------------ recipients
export const recipientKey = (r) => `${r.type}:${r.id}`;

export const cleanRecipients = (list, exclude = []) => {
  const skip = new Set((exclude || []).filter(Boolean).map((r) => recipientKey({ type: r.type, id: String(r.id) })));
  const out = new Map();
  for (const r of Array.isArray(list) ? list : []) {
    if (!r || !RECIPIENT_TYPES.includes(r.type)) continue;
    const id = r.id == null ? "" : String(r.id).trim();
    if (!id || id.length > 100) continue;
    const key = recipientKey({ type: r.type, id });
    if (!skip.has(key)) out.set(key, { type: r.type, id });
  }
  return [...out.values()];
};

const idsOf = (recipients, type) => recipients.filter((r) => r.type === type).map((r) => r.id);
const intIds = (ids) => ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);

// Email address for each recipient (Map key -> address). Archived people get none.
export const resolveEmails = async (recipients) => {
  const out = new Map();
  const studentIds = intIds(idsOf(recipients, "STUDENT"));
  if (studentIds.length) {
    const pupils = await Student.findAll({ where: { studentId: { [Op.in]: studentIds }, isDeleted: false }, attributes: ["studentId", "parentId"], raw: true });
    const parentIds = [...new Set(pupils.map((p) => p.parentId).filter((x) => x != null))];
    const parents = parentIds.length ? await Parent.findAll({ where: { parentId: { [Op.in]: parentIds } }, attributes: ["parentId", "email"], raw: true }) : [];
    const emailOf = new Map(parents.map((p) => [String(p.parentId), p.email]));
    for (const p of pupils) {
      const e = emailOf.get(String(p.parentId));
      if (isEmail(e)) out.set(`STUDENT:${p.studentId}`, e.trim());
    }
  }
  const teacherIds = intIds(idsOf(recipients, "STAFF"));
  if (teacherIds.length) {
    const rows = await Teacher.findAll({ where: { teacherId: { [Op.in]: teacherIds }, isDeleted: false }, attributes: ["teacherId", "email"], raw: true });
    for (const t of rows) if (isEmail(t.email)) out.set(`STAFF:${t.teacherId}`, t.email.trim());
  }
  const usernames = idsOf(recipients, "OFFICE");
  if (usernames.length) {
    const rows = await UserAccount.findAll({ where: { username: { [Op.in]: usernames }, isDeleted: { [Op.not]: true } }, attributes: ["username", "email"], raw: true });
    for (const u of rows) if (isEmail(u.email)) out.set(`OFFICE:${u.username}`, u.email.trim());
  }
  return out;
};

// Absolute link for an email: PORTAL_URL (pupils, teachers) or ADMIN_URL (office).
const appBase = (type) => String((type === "OFFICE" ? process.env.ADMIN_URL : process.env.PORTAL_URL) || "").trim().replace(/\/+$/, "");
export const absoluteLink = (type, link) => {
  if (!link || !String(link).startsWith("/")) return null;
  const base = appBase(type);
  return /^https?:\/\//i.test(base) ? `${base}${link}` : null;
};

// ------------------------------------------------------------------ email queue
// One queue for the whole API: one SMTP connection, batches with a pause, and
// a daily cap (Gmail allows about 500 a day). A bad address fails alone.
let mailQueue = Promise.resolve();
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const startOfTodayUtc = () => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

const writeLog = async (row) => {
  try {
    await EmailLog.create({ ...row, subject: clip(row.subject, 200), error: clip(row.error, 300), createdAt: new Date() });
  } catch (e) {
    log("email log not written", e);
  }
};

// jobs: [{ to, recipient, subject, text, html }]
export const sendEmailBatch = async (type, jobs) => {
  const cfg = mailConfig();
  if (cfg.driver === "off" || !jobs.length) return { sent: 0, logged: 0, failed: 0 };
  let remaining = Infinity;
  if (cfg.driver === "smtp" && cfg.dailyLimit > 0 && !TYPES[type]?.priority) {
    try {
      const sentToday = await EmailLog.count({ where: { status: "SENT", createdAt: { [Op.gte]: startOfTodayUtc() } } });
      remaining = Math.max(0, cfg.dailyLimit - sentToday);
    } catch (e) {
      log("could not count today's emails", e);
    }
  }
  const counts = { sent: 0, logged: 0, failed: 0 };
  for (let i = 0; i < jobs.length; i += cfg.batchSize) {
    if (i > 0 && cfg.driver === "smtp" && cfg.batchPauseMs) await pause(cfg.batchPauseMs);
    for (const job of jobs.slice(i, i + cfg.batchSize)) {
      let res;
      if (cfg.driver === "smtp" && remaining <= 0) res = { status: "FAILED", error: `Daily email limit (${cfg.dailyLimit}) reached; not sent` };
      else res = await sendMail(job, cfg);
      if (res.status === "SENT") {
        counts.sent += 1;
        remaining -= 1;
      } else if (res.status === "LOGGED") counts.logged += 1;
      else counts.failed += 1;
      if (res.status === "FAILED") console.warn(`[mail] ${type} email failed: ${res.error}`);
      await writeLog({
        notificationType: type,
        recipientType: job.recipient?.type ?? null,
        recipientId: job.recipient?.id ?? null,
        toAddress: clip(job.to, 255),
        subject: job.subject,
        status: res.status,
        error: res.error ?? null,
      });
    }
  }
  return counts;
};

const queueEmails = (type, jobs) => {
  const run = mailQueue.then(() => sendEmailBatch(type, jobs)).catch((e) => {
    log("email batch failed", e);
    return { sent: 0, logged: 0, failed: jobs.length };
  });
  mailQueue = run.then(() => undefined);
  return run;
};

// ------------------------------------------------------------------ notify
/**
 * notify({ type, recipients, title, body, link, entity, exclude, emailText })
 *   link: "/path" or (recipientType) => "/path" | null (portal vs office pages)
 *   entity: { type, id } (what it is about; used for "already sent?" checks)
 *   emailText: optional longer body for the email
 * -> { inApp, emails, done }   (done resolves when the emails are handled)
 * Never throws.
 */
export const notify = async ({ type, recipients, title, body = null, link = null, entity = null, exclude = [], emailText = null } = {}) => {
  const none = { inApp: 0, emails: 0, done: Promise.resolve() };
  try {
    if (!TYPES[type] || !title) return none;
    const list = cleanRecipients(recipients, exclude);
    if (!list.length) return none;
    const setting = (await getTypeSettings())[type] || { inApp: true, email: false };
    if (!setting.inApp && !setting.email) return none;
    const linkFor = (rtype) => clip(typeof link === "function" ? link(rtype) : link, 300);

    let inApp = 0;
    if (setting.inApp) {
      const now = new Date();
      const rows = list.map((r) => ({
        recipientType: r.type,
        recipientId: r.id,
        type,
        title: clip(title, 200),
        body: body == null ? null : String(body).slice(0, 4000),
        linkUrl: linkFor(r.type),
        entityType: clip(entity?.type, 30),
        entityId: entity?.id == null ? null : clip(entity.id, 60),
        readAt: null,
        createdAt: now,
      }));
      for (let i = 0; i < rows.length; i += CHUNK) {
        try {
          await UserNotification.bulkCreate(rows.slice(i, i + CHUNK));
          inApp += Math.min(CHUNK, rows.length - i);
        } catch (e) {
          log(`${type} in-app rows not written`, e);
        }
      }
    }

    let emails = 0;
    let done = Promise.resolve();
    if (setting.email && mailConfig().driver !== "off") {
      try {
        const addresses = await resolveEmails(list);
        const school = await getSchoolSettings().catch(() => ({}));
        const seen = new Set(); // siblings share a parent: one email per address
        const jobs = [];
        for (const r of list) {
          const to = addresses.get(recipientKey(r));
          if (!to || seen.has(to.toLowerCase())) continue;
          seen.add(to.toLowerCase());
          const mail = renderNotificationEmail({ school, title, body: emailText || body, url: absoluteLink(r.type, linkFor(r.type)) });
          jobs.push({ to, recipient: r, ...mail });
        }
        emails = jobs.length;
        if (jobs.length) done = queueEmails(type, jobs);
      } catch (e) {
        log(`${type} emails not queued`, e);
      }
    }
    return { inApp, emails, done };
  } catch (e) {
    log(`${type} failed`, e);
    return none;
  }
};

// ------------------------------------------------------------------ the caller's own
// Recipient from a verified token (portal or office).
export const recipientOf = (user) => {
  if (user?.category) {
    if (!user.username) throw new AppError("You do not have permission to perform this action", 403);
    return { type: "OFFICE", id: String(user.username) };
  }
  if (user?.userRole === "STU" && user.id != null) return { type: "STUDENT", id: String(user.id) };
  if (user?.userRole === "STAFF" && user.id != null) return { type: "STAFF", id: String(user.id) };
  throw new AppError("You do not have permission to perform this action", 403);
};

const mine = (rec) => ({ recipientType: rec.type, recipientId: rec.id });

const toInt = (v, fallback) => {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

const serialize = (n) => ({
  notificationId: n.notificationId,
  type: n.type,
  title: n.title,
  body: n.body ?? null,
  linkUrl: n.linkUrl ?? null,
  entityType: n.entityType ?? null,
  entityId: n.entityId ?? null,
  readAt: n.readAt ? new Date(n.readAt).toISOString() : null,
  createdAt: n.createdAt ? new Date(n.createdAt).toISOString() : null,
});

export const unreadCount = async (rec) => ({
  unread: await UserNotification.count({ where: { ...mine(rec), readAt: null } }),
});

// GET /notifications?unreadOnly&page&limit[&before=<notificationId>].
// Newest first by id. `before` pages by cursor (rows older than that id), so
// rows read or added in between don't shift the next page. `unread` always
// counts every unread row, whatever the filter.
export const listNotifications = async (rec, query = {}) => {
  const limit = Math.min(toInt(query.limit, LIST_DEFAULT), LIST_MAX);
  const page = toInt(query.page, 1);
  const unreadOnly = query.unreadOnly === true || query.unreadOnly === "true" || query.unreadOnly === "1";
  const before = toInt(query.before, null);
  const where = { ...mine(rec), ...(unreadOnly ? { readAt: null } : {}), ...(before ? { notificationId: { [Op.lt]: before } } : {}) };
  const { rows, count } = await UserNotification.findAndCountAll({
    where,
    order: [["notificationId", "DESC"]],
    limit,
    offset: before ? 0 : (page - 1) * limit,
    raw: true,
  });
  const { unread } = await unreadCount(rec);
  const hasMore = (before ? 0 : (page - 1) * limit) + rows.length < count;
  return { notifications: rows.map(serialize), total: count, page: before ? 1 : page, limit, totalPages: Math.ceil(count / limit), hasMore, unread };
};

// Someone else's notification is a 404 (never "exists but not yours").
export const markRead = async (rec, notificationId) => {
  const id = Number(notificationId);
  if (!Number.isInteger(id) || id <= 0) throw new AppError("Notification not found", 404);
  const row = await UserNotification.findOne({ where: { notificationId: id, ...mine(rec) }, raw: true });
  if (!row) throw new AppError("Notification not found", 404);
  if (!row.readAt) {
    const readAt = new Date();
    await UserNotification.update({ readAt }, { where: { notificationId: id, ...mine(rec), readAt: null } });
    return serialize({ ...row, readAt });
  }
  return serialize(row); // already read: keep the first time
};

export const markAllRead = async (rec) => {
  const [count] = await UserNotification.update({ readAt: new Date() }, { where: { ...mine(rec), readAt: null } });
  return { count };
};

// ------------------------------------------------------------------ settings (Administrator)
export const getNotificationSettings = async () => {
  clearNotifySettingsCache();
  const map = await getTypeSettings();
  const cfg = mailConfig();
  return {
    types: Object.entries(TYPES).map(([type, t]) => ({ type, label: t.label, who: t.who, inAppLocked: !!t.inAppLocked, ...map[type] })),
    email: { driver: cfg.driver, from: cfg.driver === "smtp" ? cfg.fromAddress : null, dailyLimit: cfg.dailyLimit },
  };
};

export const updateNotificationSettings = async (body = {}, { username = null } = {}) => {
  const list = Array.isArray(body.types) ? body.types : null;
  if (!list || !list.length) throw new AppError("Nothing to save.", 400);
  const seen = new Set();
  const rows = list.map((t) => {
    if (!t || !TYPES[t.type] || seen.has(t.type)) throw new AppError("Unknown notification type.", 400);
    seen.add(t.type);
    if (typeof t.inApp !== "boolean" || typeof t.email !== "boolean") throw new AppError("Each switch must be on or off.", 400);
    if (TYPES[t.type].inAppLocked && !t.inApp) throw new AppError(`"${TYPES[t.type].label}" always shows in the apps; only its email can be turned off.`, 400);
    return { type: t.type, inApp: t.inApp, email: t.email, updatedBy: username, updatedAt: new Date() };
  });
  for (const r of rows) await NotificationSetting.upsert(r);
  clearNotifySettingsCache();
  return getNotificationSettings();
};

export const listEmailLog = async (query = {}) => {
  const limit = Math.min(toInt(query.limit, 50), LIST_MAX);
  const page = toInt(query.page, 1);
  const { rows, count } = await EmailLog.findAndCountAll({
    order: [["createdAt", "DESC"], ["emailId", "DESC"]],
    limit,
    offset: (page - 1) * limit,
    attributes: ["emailId", "notificationType", "toAddress", "subject", "status", "error", "createdAt"],
    raw: true,
  });
  return { emails: rows, total: count, page, limit, totalPages: Math.ceil(count / limit) };
};

// ------------------------------------------------------------------ triggers
const fullName = (s) => [s?.fName, s?.mName, s?.lName].filter(Boolean).join(" ");
// Term.term holds "1" / "2" / "3" (old rows may say "Term 1").
export const termLabel = (t) => {
  const v = String(t ?? "").trim();
  return /^term\b/i.test(v) ? v : `Term ${v}`;
};

// B15: a post became visible (first publish). Its audience, minus the author.
//   ALL      every pupil, every teacher, every office login
//   CLASSES  the pupils of those classes and their class teachers
//   STAFF    every teacher and every office login
export const notifyPostPublished = async (post) => {
  try {
    if (!post) return null;
    const audience = post.audience || "ALL";
    const recipients = [];
    if (audience === "ALL" || audience === "CLASSES") {
      const classIds = (post.audienceClassIds || []).map(Number).filter(Number.isInteger);
      if (audience === "CLASSES" && !classIds.length) return null;
      const where = { isDeleted: false, ...(audience === "CLASSES" ? { classId: { [Op.in]: classIds } } : {}) };
      const pupils = await Student.findAll({ where, attributes: ["studentId"], raw: true });
      for (const p of pupils) recipients.push({ type: "STUDENT", id: p.studentId });
    }
    if (audience === "ALL" || audience === "STAFF") {
      const teachers = await Teacher.findAll({ where: { isDeleted: false }, attributes: ["teacherId"], raw: true });
      for (const t of teachers) recipients.push({ type: "STAFF", id: t.teacherId });
      const office = await UserAccount.findAll({ where: { isDeleted: { [Op.not]: true } }, attributes: ["username"], raw: true });
      for (const u of office) recipients.push({ type: "OFFICE", id: u.username });
    } else if (audience === "CLASSES") {
      const classes = await Class.findAll({ where: { classId: { [Op.in]: post.audienceClassIds.map(Number) } }, attributes: ["teacherId"], raw: true });
      for (const c of classes) if (c.teacherId) recipients.push({ type: "STAFF", id: c.teacherId });
    }
    const kind = post.postType === "EVENT" ? "New event" : post.postType === "POLL" ? "New poll" : "News";
    const body = String(post.description || "").replace(/\s+/g, " ").trim();
    return await notify({
      type: "NEWS_POST",
      recipients,
      exclude: post.createdBy ? [{ type: "OFFICE", id: post.createdBy }] : [],
      title: `${kind}: ${post.name}`,
      body: body.length > 160 ? `${body.slice(0, 157)}...` : body || null,
      emailText: post.description || null,
      link: (t) => (t === "OFFICE" ? "/news" : "/"),
      entity: { type: "post", id: post.eventId },
    });
  } catch (e) {
    log("news post", e);
    return null;
  }
};

// A fee payment was recorded (after commit). Server values only.
export const notifyPaymentRecorded = async ({ studentId, paid, owing, receiptNo, feeId } = {}) => {
  try {
    if (!studentId) return null;
    const s = await Student.findByPk(studentId, { attributes: ["studentId", "fName", "mName", "lName"], raw: true });
    if (!s) return null;
    const balance = Number(owing) < 0 ? `${formatGhs(-Number(owing))} in credit` : formatGhs(owing);
    return await notify({
      type: "PAYMENT_RECORDED",
      recipients: [{ type: "STUDENT", id: s.studentId }],
      title: `Payment received: ${formatGhs(paid)}`,
      body: `We received ${formatGhs(paid)} in fees for ${fullName(s)}.${receiptNo ? ` Receipt ${receiptNo}.` : ""} Balance now: ${balance}.`,
      link: "/fees",
      entity: { type: "fee", id: feeId ?? receiptNo ?? null },
    });
  } catch (e) {
    log("payment", e);
    return null;
  }
};

// An invoice was issued (B14; after commit). Reads the issued row, so only
// real, numbered invoices are announced.
export const notifyInvoiceIssued = async (invoiceId) => {
  try {
    if (!invoiceId) return null;
    const inv = await Invoice.findByPk(invoiceId, { attributes: ["invoiceId", "invoiceNo", "studentId", "status", "total", "balance", "dueDate"], raw: true });
    if (!inv || !inv.invoiceNo || inv.status === "DRAFT" || inv.status === "VOID") return null;
    const s = await Student.findByPk(inv.studentId, { attributes: ["studentId", "fName", "mName", "lName"], raw: true });
    if (!s) return null;
    const due = inv.dueDate ? ` Due ${String(inv.dueDate).slice(0, 10)}.` : "";
    return await notify({
      type: "INVOICE_ISSUED",
      recipients: [{ type: "STUDENT", id: s.studentId }],
      title: `Invoice ${inv.invoiceNo}`,
      body: `Invoice ${inv.invoiceNo} for ${fullName(s)}: ${formatGhs(inv.total)}. Balance: ${formatGhs(inv.balance)}.${due}`,
      link: "/fees",
      entity: { type: "invoice", id: inv.invoiceId },
    });
  } catch (e) {
    log("invoice issued", e);
    return null;
  }
};

// A register was saved: one notice per pupil marked absent, once per day
// (marking the register again doesn't repeat it).
export const notifyAbsences = async (marks, date) => {
  try {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(date || "")) ? String(date) : new Date().toISOString().slice(0, 10);
    const absent = [...new Set((marks || []).filter((m) => String(m?.status ?? "").trim().toLowerCase() === "absent").map((m) => Number(m.studentId)).filter((n) => Number.isInteger(n) && n > 0))];
    if (!absent.length) return null;
    const entityIds = absent.map((id) => `${id}:${day}`);
    const already = await UserNotification.findAll({ where: { type: "ATTENDANCE_ABSENT", entityType: "attendance", entityId: { [Op.in]: entityIds } }, attributes: ["entityId"], raw: true });
    const done = new Set(already.map((r) => r.entityId));
    const todo = absent.filter((id) => !done.has(`${id}:${day}`));
    if (!todo.length) return null;
    const pupils = await Student.findAll({ where: { studentId: { [Op.in]: todo } }, attributes: ["studentId", "fName", "mName", "lName"], raw: true });
    const results = [];
    for (const p of pupils) {
      results.push(
        await notify({
          type: "ATTENDANCE_ABSENT",
          recipients: [{ type: "STUDENT", id: p.studentId }],
          title: "Marked absent",
          body: `${fullName(p)} was marked absent on ${day}. If this is wrong, please contact the class teacher.`,
          link: "/attendance",
          entity: { type: "attendance", id: `${p.studentId}:${day}` },
        })
      );
    }
    return results;
  } catch (e) {
    log("absence", e);
    return null;
  }
};

// A password was changed through "forgot password". who: { type, id } or
// { type: "OFFICE", teacherId } (office resets go by staff id).
export const notifyPasswordChanged = async (who = {}) => {
  try {
    let recipients = [];
    if (who.type === "OFFICE" && who.teacherId != null) {
      const rows = await UserAccount.findAll({ where: { teacherId: who.teacherId }, attributes: ["username"], raw: true });
      recipients = rows.map((r) => ({ type: "OFFICE", id: r.username }));
    } else if (who.type && who.id != null) {
      recipients = [{ type: who.type, id: who.id }];
    }
    return await notify({
      type: "PASSWORD_CHANGED",
      recipients,
      title: "Your password was changed",
      body: `Your password was changed on ${new Date().toISOString().slice(0, 16).replace("T", " ")} (GMT). If you did not do this, contact the school office straight away.`,
      entity: { type: "password", id: null },
    });
  } catch (e) {
    log("password", e);
    return null;
  }
};

// ------------------------------------------------------------------ office actions
const COOLDOWN_MS = 60 * 60 * 1000;

// entityId may be an exact id or { [Op.iLike]: "3:%" } (any term of class 3).
const sentRecently = async (type, entityType, entityId) =>
  !!(await UserNotification.findOne({
    where: { type, entityType, entityId, createdAt: { [Op.gte]: new Date(Date.now() - COOLDOWN_MS) } },
    attributes: ["notificationId"],
    raw: true,
  }));

// Two clicks at the same moment: the second waits for nothing, it is refused.
// (One API process; the cooldown row covers everything after the first send.)
const inFlight = new Set();
const once = async (key, busyMessage, fn) => {
  if (inFlight.has(key)) throw new AppError(busyMessage, 409);
  inFlight.add(key);
  try {
    return await fn();
  } finally {
    inFlight.delete(key);
  }
};

// "Results are ready" for one class and term (Report cards page). Same access
// as the report cards: Administrator, or the Class Teacher of that class.
export const sendResultsReady = async ({ classId, termId } = {}, user) => {
  const info = await getCompleteness({ classId, termId }, user); // 403 / 404 / 400 from there
  const pupils = (info.students || []).filter((s) => s.hasResult);
  if (!pupils.length) throw new AppError("No pupil in this class has results for this term yet.", 400);
  const entityId = `${info.class.classId}:${info.term.termId}`;
  // Once an hour per CLASS (any term), so looping over old terms can't flood parents.
  return once(`results:${info.class.classId}`, "This class is being told already.", async () => {
  if (await sentRecently("RESULTS_READY", "class-term", { [Op.iLike]: `${info.class.classId}:%` })) {
    throw new AppError("This class was told less than an hour ago.", 409);
  }
  const res = await notify({
    type: "RESULTS_READY",
    recipients: pupils.map((p) => ({ type: "STUDENT", id: p.studentId })),
    title: `Results ready: ${termLabel(info.term.term)}`,
    body: `The ${termLabel(info.term.term)} results for ${info.class.name} are ready. Open Results in the portal to see the report card.`,
    link: "/results",
    entity: { type: "class-term", id: entityId },
  });
  return { notified: res.inApp, emails: res.emails, pupils: pupils.length, complete: !!info.complete };
  });
};

// Remind teachers whose subjects still have pupils without scores in the
// open term (teaching assignments, B2). Nursery / KG classes are left out
// (their scores are entered by the office). Administrator.
export const findMissingScores = async (termId) => {
  const assignments = await TeachingAssignment.findAll({ where: { termId }, attributes: ["teacherId", "classId", "subjectId"], raw: true });
  if (!assignments.length) return [];
  const classIds = [...new Set(assignments.map((a) => Number(a.classId)))];
  const classes = await Class.findAll({ where: { classId: { [Op.in]: classIds }, isDeleted: false }, attributes: ["classId", "name", "section"], raw: true });
  const classOf = new Map(classes.filter((c) => !isKgSection(c.section)).map((c) => [Number(c.classId), c]));
  if (!classOf.size) return [];
  const pupils = await Student.findAll({ where: { isDeleted: false, classId: { [Op.in]: [...classOf.keys()] } }, attributes: ["studentId", "classId"], raw: true });
  const rosterOf = new Map();
  for (const p of pupils) {
    const k = Number(p.classId);
    if (!rosterOf.has(k)) rosterOf.set(k, new Set());
    rosterOf.get(k).add(Number(p.studentId));
  }
  const marks = await StudentMarks.findAll({ where: { termId, studentId: { [Op.in]: pupils.map((p) => p.studentId) } }, attributes: ["studentId", "subjectId"], raw: true });
  const marked = new Set(marks.map((m) => `${Number(m.studentId)}:${Number(m.subjectId)}`));
  const subjects = await Subject.findAll({ where: { subjectId: { [Op.in]: [...new Set(assignments.map((a) => Number(a.subjectId)))] } }, attributes: ["subjectId", "name"], raw: true });
  const subjectName = new Map(subjects.map((s) => [Number(s.subjectId), s.name]));

  const out = [];
  for (const a of assignments) {
    const klass = classOf.get(Number(a.classId));
    const roster = rosterOf.get(Number(a.classId));
    if (!klass || !roster?.size || !a.teacherId) continue;
    const missing = [...roster].filter((sid) => !marked.has(`${sid}:${Number(a.subjectId)}`)).length;
    if (missing) {
      out.push({ teacherId: Number(a.teacherId), classId: klass.classId, className: klass.name, subjectId: Number(a.subjectId), subjectName: subjectName.get(Number(a.subjectId)) || "a subject", missing, expected: roster.size });
    }
  }
  return out;
};

export const sendScoresReminder = async () => {
  const term = await Term.findOne({ where: { active: true }, raw: true });
  if (!term) throw new AppError("No term is open. Open a term in Settings first.", 409);
  const entityId = `term:${term.termId}`;
  return once(`scores:${term.termId}`, "The reminder is being sent already.", async () => {
  if (await sentRecently("SCORES_MISSING", "term", entityId)) {
    throw new AppError("Teachers were reminded less than an hour ago.", 409);
  }
  const gaps = await findMissingScores(term.termId);
  const byTeacher = new Map();
  for (const g of gaps) {
    if (!byTeacher.has(g.teacherId)) byTeacher.set(g.teacherId, []);
    byTeacher.get(g.teacherId).push(g);
  }
  let notified = 0;
  for (const [teacherId, list] of byTeacher) {
    const lines = list.map((g) => `${g.subjectName} - ${g.className}: ${g.missing} of ${g.expected} pupils`);
    const res = await notify({
      type: "SCORES_MISSING",
      recipients: [{ type: "STAFF", id: teacherId }],
      title: `Scores missing for ${termLabel(term.term)}`,
      body: `Some pupils have no score yet:\n${lines.join("\n")}`,
      link: "/scores",
      entity: { type: "term", id: entityId },
    });
    notified += res.inApp;
  }
  return { teachers: byTeacher.size, notified, gaps: gaps.length, term: termLabel(term.term) };
  });
};
