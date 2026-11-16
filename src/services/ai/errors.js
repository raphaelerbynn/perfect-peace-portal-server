// AI-0: the AI error types.
//
// AiProviderError: a provider call failed, already classified (errorClass).
//   Feature code decides from errorClass, never from the message.
// AiUnavailableError (403, code AI_DISABLED): the server, the school or the
//   feature is switched off. The page must still work by hand.
// AiQuotaError (429, code AI_QUOTA): this month's spend reached the cap.
// toUserError(): turns an AiProviderError into a friendly AppError for a route.
import { AppError } from "../../utils/errorHandling.js";
import { RETRYABLE_ERROR_CLASSES } from "./constants.js";

export class AiProviderError extends Error {
  constructor(errorClass, message, { cause, status, usage } = {}) {
    super(message);
    this.name = "AiProviderError";
    this.errorClass = errorClass;
    this.cause = cause;
    this.status = status;
    // Tokens already spent on the failed attempts (so failures still cost).
    this.usage = usage;
  }

  get retryable() {
    return RETRYABLE_ERROR_CLASSES.includes(this.errorClass);
  }
}

// An AppError whose message (and code/details) reach the client even for 5xx.
class AiAppError extends AppError {
  constructor(message, status, code, details = {}) {
    super(message, status);
    this.code = code;
    this.details = details;
    this.expose = true;
  }
}

const OFF_TEXT = {
  SERVER_OFF: "AI is switched off on the server.",
  NO_KEY: "AI is not set up on the server yet (no Gemini key).",
  SCHOOL_OFF: "AI is switched off for the school. An Administrator can turn it on in Settings → AI.",
  FEATURE_OFF: "This AI feature is switched off. An Administrator can turn it on in Settings → AI.",
};

export class AiUnavailableError extends AiAppError {
  constructor(reason, feature) {
    super(`${OFF_TEXT[reason] || OFF_TEXT.SCHOOL_OFF} You can still do this by hand.`, 403, "AI_DISABLED", {
      reason,
      feature: feature || null,
    });
    this.name = "AiUnavailableError";
    this.errorClass = "DISABLED";
  }
}

export class AiQuotaError extends AiAppError {
  constructor({ spentGhs, capGhs, period }) {
    super(
      `This month's AI budget is used up (GH₵ ${Number(spentGhs).toFixed(2)} of GH₵ ${Number(capGhs).toFixed(2)}). ` +
        "It starts again next month, or an Administrator can raise the cap in Settings → AI. You can still do this by hand.",
      429,
      "AI_QUOTA",
      { spentGhs, capGhs, period }
    );
    this.name = "AiQuotaError";
    this.errorClass = "QUOTA";
  }
}

const FAIL_TEXT = {
  RATE_LIMIT: [503, "The AI service is busy right now. Please try again in a minute."],
  TIMEOUT: [504, "The AI took too long to answer. Please try again."],
  SAFETY_BLOCK: [422, "The AI would not write this (it was blocked by Google's safety filter). Try rewording it, or write it by hand."],
  MALFORMED_OUTPUT: [502, "The AI sent back something unusable. Please try again, or write it by hand."],
  AUTH: [503, "AI is not set up correctly on the server (the Gemini key was refused)."],
  PROVIDER_ERROR: [502, "The AI service returned an error. Please try again later."],
  UNKNOWN: [502, "The AI request failed. Please try again later."],
};

/** A friendly, exposable error for a failed provider call (code AI_FAILED). */
export const toUserError = (error) => {
  if (error instanceof AiAppError) return error;
  const errorClass = error instanceof AiProviderError ? error.errorClass : "UNKNOWN";
  const [status, message] = FAIL_TEXT[errorClass] || FAIL_TEXT.UNKNOWN;
  return new AiAppError(message, status, "AI_FAILED", { errorClass });
};

export { AiAppError };
