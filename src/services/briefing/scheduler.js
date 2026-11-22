// AI-5: the briefing timer. Started from src/index.js after the API is
// listening; never in tests, never when AI is off on the server
// (AI_ENABLED / GEMINI_API_KEY), never when BRIEFING_SCHEDULER=off (e.g. on a
// second instance, though the UNIQUE day key already stops duplicates).
//
// Once a minute: if today (Africa/Accra) is a chosen day and the chosen time
// has passed, and the school and the BRIEFING feature are switched on, and
// today's briefing doesn't exist yet -> make it. A plain timer rather than a
// cron library because the days and time change at runtime (Settings) and a
// missed time must be caught up the same day.
import { Op } from "sequelize";
import { AiBriefing } from "../../models/index.js";
import { aiConfig, serverBlockReason } from "../ai/config.js";
import { featureBlockReason } from "../ai/gate.js";
import { accraParts, isDue } from "./schedule.js";
import { STALE_RUN_MS, runBriefing } from "./service.js";
import { getBriefingSettings } from "./settings.js";

const TICK_MS = 60 * 1000;
let timer = null;
let busy = false;
let doneDay = null; // today's briefing is known to exist: skip the lookups

/** One check. -> NOT_DUE | OFF | DONE | BUSY | RUNNING (a fresh run exists) | RAN | SKIPPED (another instance) */
export const briefingTick = async (now = new Date()) => {
  if (busy) return "BUSY";
  busy = true;
  try {
    const date = accraParts(now).date;
    if (doneDay === date) return "DONE";
    const settings = await getBriefingSettings();
    if (!isDue(now, settings)) return "NOT_DUE";
    if (await featureBlockReason("BRIEFING")) return "OFF";
    const existing = await AiBriefing.findOne({
      where: { runKey: date, [Op.or]: [{ status: { [Op.ne]: "RUNNING" } }, { updatedAt: { [Op.gte]: new Date(now.getTime() - STALE_RUN_MS) } }] },
      attributes: ["briefingId", "status"],
      raw: true,
    });
    if (existing) {
      // A run that is still going (here or elsewhere) is not done: keep
      // checking, so a run that dies (API restart) is reclaimed by claimDay
      // once it is STALE_RUN_MS old.
      if (existing.status === "RUNNING") return "RUNNING";
      doneDay = date;
      return "DONE";
    }
    const res = await runBriefing({ now, trigger: "SCHEDULE" });
    if (res?.skipped) return "SKIPPED"; // another instance has it; look again next tick
    doneDay = date;
    return "RAN";
  } finally {
    busy = false;
  }
};

/** Start the timer (idempotent). Returns the timer, or null when it must not run. */
export const startBriefingScheduler = ({ intervalMs = TICK_MS } = {}) => {
  if (timer) return timer;
  if (process.env.NODE_ENV === "test") return null;
  if (String(process.env.BRIEFING_SCHEDULER || "").trim().toLowerCase() === "off") {
    console.log("[briefing] scheduler off (BRIEFING_SCHEDULER=off)");
    return null;
  }
  const blocked = serverBlockReason(aiConfig());
  if (blocked) {
    console.log(`[briefing] scheduler not started: AI is off on the server (${blocked})`);
    return null;
  }
  const tick = () =>
    briefingTick().catch((e) => {
      console.error("[briefing] scheduled run failed:", e?.message || e);
    });
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  setTimeout(tick, 15 * 1000).unref?.(); // catch up soon after a restart
  console.log("[briefing] scheduler started (Africa/Accra)");
  return timer;
};

export const stopBriefingScheduler = () => {
  if (timer) clearInterval(timer);
  timer = null;
};

// Tests only.
export const __resetBriefingScheduler = () => {
  stopBriefingScheduler();
  busy = false;
  doneDay = null;
};
