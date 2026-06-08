import { sendSMSMessage } from "../services/messaging.js";
import { AppError } from "../utils/errorHandling.js";

// Bulk SMS (Administrator-only — mounted behind authorizeRoles("Administrator")).
// Per the messaging review there is intentionally NO hard recipient cap (the UI
// shows a "send to N recipients?" confirmation instead); the service validates,
// normalizes and de-duplicates the recipients and THROWS on provider failure,
// so a failed/empty send no longer reports a false "sent successfully".
const sendSMS = async (req, res, next) => {
    const { contacts, message } = req.body;

    try {
      // BE-2: validate before touching the provider (was forwarding raw body,
      // crashing on undefined / sending to arbitrary numbers).
      if (!Array.isArray(contacts) || contacts.length === 0) {
        throw new AppError("contacts must be a non-empty array", 400);
      }
      if (!message || String(message).trim() === "") {
        throw new AppError("message is required", 400);
      }

      const result = await sendSMSMessage(message, contacts);

      // BE-6: report the real provider result (no PII logged).
      res.status(200).json({ message: "SMS dispatched", result });
    } catch (err) {
      next(err);
    }
  };

  export { sendSMS }