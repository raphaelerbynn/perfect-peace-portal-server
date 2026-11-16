// AI-0: every AI setting that comes from the environment. Read on each call
// (not at import) so tests and a restarted process see the current values,
// and a bad number never turns into NaN inside the budget arithmetic.

const num = (name, fallback, { min = -Infinity } = {}) => {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? n : fallback;
};
const bool = (name, fallback = false) => {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
};
const str = (name, fallback) => {
  const raw = process.env[name];
  return raw === undefined || String(raw).trim() === "" ? fallback : String(raw).trim();
};

// Same baseline as SchoolPro (2.5 Flash-Lite retires Oct 2026).
export const DEFAULT_MODEL = "gemini-3.1-flash-lite";

// Estimated provider prices in USD per million tokens. Google does not return
// a price, so cost is tokens x this table. Unknown model -> the dearest row, so
// a new model can only over-count against the cap, never slip past it.
// Check these against https://ai.google.dev/gemini-api/docs/pricing when the
// key is set up; AI_PRICES_JSON overrides any row, e.g.
//   AI_PRICES_JSON={"gemini-3.1-flash-lite":{"input":0.25,"cached":0.025,"output":1.5}}
export const MODEL_PRICES_USD_PER_MTOK = Object.freeze({
  "gemini-3.1-flash-lite": { input: 0.25, cached: 0.025, output: 1.5 },
  "gemini-3-flash": { input: 0.5, cached: 0.05, output: 3.0 },
  "gemini-2.5-flash-lite": { input: 0.1, cached: 0.025, output: 0.4 },
  "gemini-2.5-flash": { input: 0.3, cached: 0.075, output: 2.5 },
  "gemini-2.5-pro": { input: 1.25, cached: 0.31, output: 10.0 },
});

const priceTable = () => {
  let extra = {};
  try {
    extra = process.env.AI_PRICES_JSON ? JSON.parse(process.env.AI_PRICES_JSON) : {};
  } catch {
    extra = {};
  }
  return { ...MODEL_PRICES_USD_PER_MTOK, ...extra };
};

/** The price row for a model ("models/gemini-x-001" and version suffixes match their base). */
export const priceFor = (model) => {
  const table = priceTable();
  const name = String(model || "").replace(/^models\//, "");
  if (table[name]) return table[name];
  const base = Object.keys(table)
    .filter((k) => name.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  if (base) return table[base];
  return Object.values(table).reduce((worst, p) => (p.output > worst.output ? p : worst));
};

export const aiConfig = () => {
  const production = process.env.NODE_ENV === "production";
  const fakeProvider = !production && bool("AI_FAKE_PROVIDER", false);
  const apiKey = str("GEMINI_API_KEY", "");
  const envEnabled = bool("AI_ENABLED", false);
  return {
    // Off unless the server says so: a missing env var must not start billing.
    envEnabled,
    apiKey,
    // Dev only: canned answers, no network (refused in production).
    fakeProvider,
    // The server can send anything at all: switched on AND a key (or the fake).
    serverReady: envEnabled && (Boolean(apiKey) || fakeProvider),
    defaultModel: str("AI_MODEL_DEFAULT", DEFAULT_MODEL),
    // Cap when the Administrator hasn't set one on Settings -> AI.
    monthlyBudgetGhs: num("AI_MONTHLY_BUDGET_GHS", 200, { min: 0 }),
    // Cedis per US dollar, for the cost of each call.
    usdToGhs: num("AI_USD_TO_GHS", 15.5, { min: 0.01 }),
    timeoutMs: num("AI_REQUEST_TIMEOUT_MS", 60_000, { min: 1000 }),
    maxRetries: num("AI_MAX_RETRIES", 2, { min: 0 }),
    retryBaseDelayMs: num("AI_RETRY_BASE_DELAY_MS", 500, { min: 0 }),
    maxToolIterations: num("AI_MAX_TOOL_ITERATIONS", 5, { min: 1 }),
  };
};

/** Why the server can't send anything right now, or null when it can. */
export const serverBlockReason = (cfg = aiConfig()) => {
  if (!cfg.envEnabled) return "SERVER_OFF";
  if (!cfg.apiKey && !cfg.fakeProvider) return "NO_KEY";
  return null;
};
