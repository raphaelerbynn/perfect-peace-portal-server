// AI-0: the school's AI switches (Ai_settings, one row). Cached for 30 s; a
// save clears the cache. A database without migration 043 behaves as "AI off"
// instead of failing the page.
import { AiSettings } from "../../models/index.js";
import { AppError } from "../../utils/errorHandling.js";
import { round2, toNum } from "../../utils/money.js";
import { AI_FEATURE_INFO, AI_FEATURE_KEYS, DEFAULT_TONE } from "./constants.js";
import { aiConfig, serverBlockReason } from "./config.js";

const CACHE_MS = 30 * 1000;
let cache = null;
export const clearAiSettingsCache = () => {
  cache = null;
};

const MAX_CAP_GHS = 100000;
const MAX_SALUTATION = 80;

const defaultToggles = () => Object.fromEntries(AI_FEATURE_KEYS.map((k) => [k, AI_FEATURE_INFO[k].defaultOn]));

const asObject = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

/** The row merged over the defaults: { enabled, featureToggles, monthlyCapGhs, capFromEnv, tone, updatedBy, updatedAt }. */
export const getAiSettings = async ({ fresh = false } = {}) => {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  let row = null;
  try {
    row = await AiSettings.findOne({ where: { aiSettingsId: 1 }, raw: true });
  } catch (e) {
    const code = e?.original?.code || e?.parent?.code;
    if (code !== "42P01") throw e; // undefined_table: migration 043 not applied yet
  }
  const toggles = asObject(row?.featureToggles);
  const cap = row?.monthlyCapGhs;
  const value = {
    enabled: Boolean(row?.enabled),
    featureToggles: Object.fromEntries(
      AI_FEATURE_KEYS.map((k) => [k, typeof toggles[k] === "boolean" ? toggles[k] : AI_FEATURE_INFO[k].defaultOn])
    ),
    monthlyCapGhs: cap === null || cap === undefined ? aiConfig().monthlyBudgetGhs : toNum(cap),
    capFromEnv: cap === null || cap === undefined,
    tone: { ...DEFAULT_TONE, ...asObject(row?.tone) },
    updatedBy: row?.updatedBy || null,
    updatedAt: row?.updatedAt || null,
    tableMissing: !row,
  };
  cache = { at: Date.now(), value };
  return value;
};

/** What the Settings -> AI page needs: the settings, the server's state and the features. */
export const getAiSettingsForAdmin = async () => {
  const settings = await getAiSettings({ fresh: true });
  const cfg = aiConfig();
  return {
    ...settings,
    server: {
      ready: cfg.serverReady,
      envEnabled: cfg.envEnabled,
      hasKey: Boolean(cfg.apiKey),
      fakeProvider: cfg.fakeProvider,
      blockReason: serverBlockReason(cfg),
      model: cfg.defaultModel,
      envCapGhs: cfg.monthlyBudgetGhs,
      usdToGhs: cfg.usdToGhs,
    },
    features: AI_FEATURE_KEYS.map((key) => ({
      key,
      label: AI_FEATURE_INFO[key].label,
      description: AI_FEATURE_INFO[key].description,
      later: Boolean(AI_FEATURE_INFO[key].later),
      roles: [...AI_FEATURE_INFO[key].office, ...AI_FEATURE_INFO[key].portal.map((r) => (r === "STAFF" ? "Teachers (portal)" : r))],
      on: settings.featureToggles[key],
    })),
  };
};

const bad = (message) => new AppError(message, 400);

/**
 * PUT /ai/settings. Partial: only the keys sent change.
 *   { enabled?, featureToggles?: { ASK: true, ... }, monthlyCapGhs?: number | null, tone?: { formal, salutation, britishSpelling } }
 * Switching AI on is refused while the server can't send anything (AI_ENABLED
 * off or no key), so the page never shows "on" for something that can't work.
 */
export const updateAiSettings = async (body = {}, { username } = {}) => {
  const current = await getAiSettings({ fresh: true });
  if (current.tableMissing) {
    // Not an error users can fix: the database is behind the code.
    throw new AppError("AI settings are not available yet (database migration 043 has not been applied).", 409);
  }
  const patch = {};

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") throw bad("enabled must be true or false.");
    if (body.enabled && !current.enabled) {
      const reason = serverBlockReason();
      if (reason === "SERVER_OFF") throw bad("AI can't be switched on: it is switched off on the server (AI_ENABLED). Ask the developer.");
      if (reason === "NO_KEY") throw bad("AI can't be switched on: the server has no Gemini key yet (GEMINI_API_KEY). Ask the developer.");
    }
    patch.enabled = body.enabled;
  }

  if (body.featureToggles !== undefined) {
    const t = asObject(body.featureToggles);
    if (t !== body.featureToggles) throw bad("featureToggles must be an object.");
    const next = { ...current.featureToggles };
    for (const [k, v] of Object.entries(t)) {
      if (!AI_FEATURE_KEYS.includes(k)) throw bad(`Unknown AI feature: ${k}.`);
      if (typeof v !== "boolean") throw bad(`The switch for ${k} must be true or false.`);
      next[k] = v;
    }
    patch.featureToggles = next;
  }

  if (body.monthlyCapGhs !== undefined) {
    if (body.monthlyCapGhs === null || body.monthlyCapGhs === "") {
      patch.monthlyCapGhs = null; // back to AI_MONTHLY_BUDGET_GHS
    } else {
      let cap;
      try {
        cap = toNum(body.monthlyCapGhs);
      } catch {
        throw bad("The monthly cap must be an amount in GH₵.");
      }
      if (cap < 0 || cap > MAX_CAP_GHS) throw bad(`The monthly cap must be between GH₵ 0 and GH₵ ${MAX_CAP_GHS.toLocaleString("en-GH")}.`);
      patch.monthlyCapGhs = round2(cap);
    }
  }

  if (body.tone !== undefined) {
    const t = asObject(body.tone);
    if (t !== body.tone) throw bad("tone must be an object.");
    const next = { ...current.tone };
    if (t.formal !== undefined) {
      if (typeof t.formal !== "boolean") throw bad("tone.formal must be true or false.");
      next.formal = t.formal;
    }
    if (t.britishSpelling !== undefined) {
      if (typeof t.britishSpelling !== "boolean") throw bad("tone.britishSpelling must be true or false.");
      next.britishSpelling = t.britishSpelling;
    }
    if (t.salutation !== undefined) {
      const s = String(t.salutation ?? "").trim();
      if (s.length > MAX_SALUTATION) throw bad(`The salutation can be at most ${MAX_SALUTATION} characters.`);
      next.salutation = s;
    }
    patch.tone = { formal: next.formal, salutation: next.salutation, britishSpelling: next.britishSpelling };
  }

  if (!Object.keys(patch).length) throw bad("Nothing to save.");
  await AiSettings.update({ ...patch, updatedBy: username || null, updatedAt: new Date() }, { where: { aiSettingsId: 1 } });
  clearAiSettingsCache();
  return getAiSettingsForAdmin();
};
