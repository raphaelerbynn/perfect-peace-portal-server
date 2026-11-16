// AI-0: the usage log, the cost of a call and the monthly budget guard.
//
//   recordUsage(entry)   one Ai_usage_log row. Never throws (a lost log row
//                        must not break the page the AI sits on).
//   costOf(usage)        { costMicros (USD), costGhs } from the model's price.
//   budgetState()        { period, spentGhs, capGhs, remainingGhs, overCap }
//   assertWithinBudget() throws AiQuotaError (429) when spent >= cap.
//   usageSummary()       GET /ai/usage: spend vs cap, calls per feature, failures.
//
// The month is the calendar month in UTC, which is Ghana time (GMT, no DST).
// The check is "spent so far < cap" before a call; the call that crosses the
// cap is allowed to finish, so the cap can be passed by at most the calls
// already in flight (a few pesewas each). Good enough for one school; no
// reservations as in SchoolPro.
import { Op, fn, col } from "sequelize";
import { AiUsageLog } from "../../models/index.js";
import { round2, toNum } from "../../utils/money.js";
import { aiConfig, priceFor } from "./config.js";
import { AiQuotaError } from "./errors.js";
import { getAiSettings } from "./settings.js";

const int = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0);

export const periodOf = (now = new Date()) => `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
export const periodBounds = (now = new Date()) => ({
  start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
  end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
});

/** USD micros and GH₵ (4 places) for one call's tokens on its model. */
export const costOf = (usage, { usdToGhs = aiConfig().usdToGhs } = {}) => {
  if (!usage) return { costMicros: 0, costGhs: 0 };
  const price = priceFor(usage.model);
  const usd = (int(usage.inputTokens) * price.input + int(usage.cachedTokens) * (price.cached ?? price.input) + int(usage.outputTokens) * price.output) / 1_000_000;
  const costMicros = Math.max(0, Math.round(usd * 1_000_000));
  const costGhs = Math.round((costMicros / 1_000_000) * usdToGhs * 10000) / 10000;
  return { costMicros, costGhs };
};

/** "OFFICE:<username>" / "STAFF:<teacherId>" from a token payload. */
export const actorOf = (user) => {
  if (!user) return null;
  if (user.category) return `OFFICE:${user.username || user.category}`.slice(0, 110);
  if (user.userRole) return `${String(user.userRole).toUpperCase()}:${user.id}`.slice(0, 110);
  return null;
};

export const recordUsage = async ({ feature, user, userRef, model, promptVersion, usage, status, errorClass, errorMessage, latencyMs }) => {
  try {
    const { costMicros, costGhs } = costOf(usage ? { ...usage, model: usage.model || model } : null);
    await AiUsageLog.create({
      feature,
      userRef: userRef || actorOf(user),
      model: String(model || usage?.model || "unknown").slice(0, 60),
      promptVersion: promptVersion ? String(promptVersion).slice(0, 60) : null,
      inputTokens: int(usage?.inputTokens),
      cachedTokens: int(usage?.cachedTokens),
      outputTokens: int(usage?.outputTokens),
      costMicros,
      costGhs,
      status,
      errorClass: errorClass || null,
      errorMessage: errorMessage ? String(errorMessage).slice(0, 300) : null,
      latencyMs: latencyMs === undefined ? null : int(latencyMs),
      createdAt: new Date(),
    });
    return { costMicros, costGhs };
  } catch (error) {
    console.error(`AI usage log not written (${feature}):`, error?.message || error);
    return { costMicros: 0, costGhs: 0 };
  }
};

export const monthSpendGhs = async (now = new Date()) => {
  const { start, end } = periodBounds(now);
  const total = await AiUsageLog.sum("costGhs", { where: { createdAt: { [Op.gte]: start, [Op.lt]: end } } });
  return round2(toNum(total || 0));
};

export const budgetState = async (now = new Date()) => {
  const [settings, spentGhs] = await Promise.all([getAiSettings(), monthSpendGhs(now)]);
  const capGhs = round2(settings.monthlyCapGhs);
  return {
    period: periodOf(now),
    spentGhs,
    capGhs,
    remainingGhs: round2(Math.max(0, capGhs - spentGhs)),
    percent: capGhs > 0 ? Math.min(100, Math.round((spentGhs / capGhs) * 100)) : 100,
    overCap: spentGhs >= capGhs,
  };
};

/** The guard run before every call. Logs a BLOCKED row when it refuses. */
export const assertWithinBudget = async ({ feature, user, model } = {}) => {
  const state = await budgetState();
  if (state.overCap) {
    if (feature) {
      await recordUsage({ feature, user, model: model || aiConfig().defaultModel, status: "BLOCKED", errorClass: "QUOTA", errorMessage: `Monthly cap reached (GH₵ ${state.spentGhs} of ${state.capGhs})` });
    }
    throw new AiQuotaError(state);
  }
  return state;
};

const RECENT_FAILURES = 15;

export const usageSummary = async (now = new Date()) => {
  const { start, end } = periodBounds(now);
  const where = { createdAt: { [Op.gte]: start, [Op.lt]: end } };
  const [budget, groups, failures] = await Promise.all([
    budgetState(now),
    AiUsageLog.findAll({
      attributes: ["feature", "status", [fn("COUNT", col("usage_id")), "calls"], [fn("SUM", col("cost_ghs")), "costGhs"]],
      where,
      group: ["feature", "status"],
      raw: true,
    }),
    AiUsageLog.findAll({
      attributes: ["usageId", "feature", "userRef", "model", "promptVersion", "status", "errorClass", "errorMessage", "createdAt"],
      where: { status: { [Op.ne]: "OK" } },
      order: [["createdAt", "DESC"]],
      limit: RECENT_FAILURES,
      raw: true,
    }),
  ]);

  const byFeature = new Map();
  for (const g of groups) {
    const f = byFeature.get(g.feature) || { feature: g.feature, calls: 0, failures: 0, blocked: 0, costGhs: 0 };
    const calls = int(g.calls);
    f.calls += calls;
    if (g.status === "ERROR") f.failures += calls;
    if (g.status === "BLOCKED") f.blocked += calls;
    f.costGhs = round2(f.costGhs + toNum(g.costGhs || 0));
    byFeature.set(g.feature, f);
  }
  const features = [...byFeature.values()].sort((a, b) => b.costGhs - a.costGhs || b.calls - a.calls || a.feature.localeCompare(b.feature));

  return {
    ...budget,
    calls: features.reduce((n, f) => n + f.calls, 0),
    byFeature: features,
    recentFailures: failures,
  };
};
