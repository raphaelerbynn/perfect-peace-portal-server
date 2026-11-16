// AI-0: who may use an AI feature, and whether it is switched on.
//
//   requireAiFeature("ANNOUNCEMENTS")             Express middleware
//   requireAiFeature("PAPERS", { budget: false })  skip the cheap budget pre-check (reads)
//
// In order:
//   1. a valid token (reuses req.user if an earlier middleware set it, so it
//      works inside teacherRouter / generalRouter as well as on its own);
//   2. the role table in constants.js (AI_FEATURE_INFO[feature].office for
//      management tokens, .portal for portal tokens; STAFF = teachers)  -> 403;
//   3. the server switch (AI_ENABLED + GEMINI_API_KEY), the school switch and
//      the feature switch (Settings -> AI)  -> 403 code AI_DISABLED + reason;
//   4. unless { budget: false }: this month's spend below the cap -> 429 AI_QUOTA.
// On success: req.aiFeature = feature, req.aiActor = "OFFICE:admin" / "STAFF:3".
//
// run.js repeats 3 and 4 before every model call (cron jobs have no request).
import { authenticateUser } from "../../utils/middlewares.js";
import { AI_FEATURE_INFO } from "./constants.js";
import { aiConfig, serverBlockReason } from "./config.js";
import { AiUnavailableError } from "./errors.js";
import { getAiSettings } from "./settings.js";
import { actorOf, assertWithinBudget, budgetState } from "./usage.js";

const assertKnown = (feature) => {
  if (!AI_FEATURE_INFO[feature]) throw new Error(`Unknown AI feature "${feature}" (add it to services/ai/constants.js)`);
};

/** True when this token's role may use the feature (the B10 stand-in). */
export const roleAllowed = (feature, user) => {
  const info = AI_FEATURE_INFO[feature];
  if (!info || !user) return false;
  if (user.category) return info.office.includes(user.category);
  if (user.userRole) return info.portal.includes(String(user.userRole).toUpperCase());
  return false;
};

/** null when the feature can run now, else SERVER_OFF | NO_KEY | SCHOOL_OFF | FEATURE_OFF. */
export const featureBlockReason = async (feature) => {
  assertKnown(feature);
  const server = serverBlockReason(aiConfig());
  if (server) return server;
  const settings = await getAiSettings();
  if (!settings.enabled) return "SCHOOL_OFF";
  if (!settings.featureToggles[feature]) return "FEATURE_OFF";
  return null;
};

/** Throws AiUnavailableError when the feature is off (used by run.js and the middleware). */
export const assertAiFeatureOn = async (feature) => {
  const reason = await featureBlockReason(feature);
  if (reason) throw new AiUnavailableError(reason, feature);
};

const authenticateIfNeeded = (req, res, next) => (req.user ? next() : authenticateUser(req, res, next));

export const requireAiFeature = (feature, { budget = true } = {}) => {
  assertKnown(feature); // a typo fails at start-up, not on the first request
  return (req, res, next) =>
    authenticateIfNeeded(req, res, async (authErr) => {
      if (authErr) return next(authErr);
      try {
        if (!roleAllowed(feature, req.user)) {
          res.status(403);
          throw new Error("You do not have permission to use this AI feature.");
        }
        await assertAiFeatureOn(feature);
        if (budget) await assertWithinBudget({ user: req.user }); // cheap pre-check (amounts for Administrators only); run.js logs refusals per call
        req.aiFeature = feature;
        req.aiActor = actorOf(req.user);
        return next();
      } catch (error) {
        return next(error);
      }
    });
};

/**
 * GET /ai/status: for the signed-in caller, each feature their role may use
 * with { available, reason }, plus the budget. Lets a page show the disabled /
 * quota state up front instead of failing on click. Never reveals amounts to
 * non-Administrators.
 */
export const aiStatusFor = async (user) => {
  const cfg = aiConfig();
  const settings = await getAiSettings();
  const budget = await budgetState();
  const features = {};
  for (const [key, info] of Object.entries(AI_FEATURE_INFO)) {
    if (!roleAllowed(key, user)) continue;
    let reason = serverBlockReason(cfg);
    if (!reason && !settings.enabled) reason = "SCHOOL_OFF";
    if (!reason && !settings.featureToggles[key]) reason = "FEATURE_OFF";
    if (!reason && budget.overCap) reason = "QUOTA";
    features[key] = { available: !reason, reason, label: info.label };
  }
  const isAdmin = user?.category === "Administrator";
  return {
    features,
    overCap: budget.overCap,
    ...(isAdmin ? { budget } : {}),
  };
};
