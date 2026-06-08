import axios from "axios";
import { AppError } from "../utils/errorHandling.js";

const arkesel_key = process.env.ARKESEL_KEY;
const ARKESEL_URL = "https://sms.arkesel.com/api/v2/sms/send";

// BE-3: ONE registered sender ID, env-backed, used by every SMS path (the code
// previously hardcoded "PPeace Sch" in two places and "P Peace" in resetPin —
// an unregistered sender ID causes silent non-delivery). Set SMS_SENDER_ID in
// prod to the exact value registered with Arkesel.
export const SMS_SENDER_ID = process.env.SMS_SENDER_ID || "PPeace Sch";

// BE-4: ONE normalize+validate helper (the sender used to filter `^\d{10}$`
// while the app validated `^\+?\d{10,15}$`, so valid country-code numbers were
// silently dropped). Strip non-digits and accept a 10–15 digit number.
export const normalizeContact = (raw) => {
  if (raw == null) return null;
  const digits = String(raw).replace(/\D/g, "");
  return /^\d{10,15}$/.test(digits) ? digits : null;
};

// Send an SMS to one or more recipients via Arkesel.
//  - BE-2: requires a non-empty message and at least one VALID recipient.
//  - BE-5: de-duplicates recipients (no double-charge / double-text).
//  - BE-7: 10s timeout so a hung provider can't hang the request.
//  - BE-6: THROWS on provider failure / no valid recipients (callers that want
//    best-effort behaviour — fee/attendance/payroll — already wrap this in
//    try/catch; the bulk endpoint lets it propagate to the error handler).
//  - BE-10: never logs the provider response or axios config (recipient PII /
//    the api-key header).
const sendSMSMessage = async (message, contacts, { sender = SMS_SENDER_ID } = {}) => {
  const body = typeof message === "string" ? message.trim() : "";
  if (!body) {
    throw new AppError("Message body is required", 400);
  }

  const list = Array.isArray(contacts) ? contacts : [contacts];
  const recipients = [...new Set(list.map(normalizeContact).filter(Boolean))];
  if (recipients.length === 0) {
    throw new AppError("No valid recipients", 400);
  }

  try {
    const response = await axios({
      method: "post",
      url: ARKESEL_URL,
      headers: { "api-key": arkesel_key },
      data: { sender, message: body, recipients },
      timeout: 10000,
    });
    return response.data;
  } catch (error) {
    // Surface a clean failure; do NOT leak provider PII or the api-key header.
    throw new AppError("Failed to send SMS", 502);
  }
};

export { sendSMSMessage };
