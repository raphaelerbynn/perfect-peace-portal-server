// AI-0: the shared AI toolkit. Import from here: `import * as ai from "../services/ai/index.js"`.
// How to build a feature on it: README.md in this folder.
export * from "./constants.js";
export { aiConfig, priceFor, serverBlockReason, DEFAULT_MODEL } from "./config.js";
export { AiProviderError, AiQuotaError, AiUnavailableError, toUserError } from "./errors.js";
export { getAiClient, createAiClient, setAiProviderForTests, classifyError } from "./client.js";
export { createFakeProvider } from "./providers/fake.js";
export { runJson, runText, runChat, streamText, runToolLoop } from "./run.js";
export { redactForAi, redactText, redactedPaths } from "./redact.js";
export { requireAiFeature, assertAiFeatureOn, featureBlockReason, roleAllowed, aiStatusFor } from "./gate.js";
export { getAiSettings, getAiSettingsForAdmin, updateAiSettings, clearAiSettingsCache } from "./settings.js";
export { recordUsage, costOf, actorOf, budgetState, assertWithinBudget, usageSummary } from "./usage.js";
export {
  registerAcceptHandler,
  hasAcceptHandler,
  createSuggestion,
  listSuggestions,
  getSuggestion,
  editSuggestion,
  acceptSuggestion,
  rejectSuggestion,
} from "./suggestions.js";
export * from "./prompts/index.js";
