import { Router } from "express";
import * as notify from "../services/notify.js";
import { authenticateManagementUser, authenticateUser, requirePermission } from "../utils/middlewares.js";

// B16: in-app notifications, for EVERY kind of login (portal pupils and
// teachers, office logins). Each caller reads and marks only their own
// notifications (recipient from the token; anyone else's is a 404).
// Office-only actions (switches, email log, "results ready", scores
// reminder) check the management token and a permission per route.
const router = Router();

const send = (fn) => async (req, res, next) => {
  try {
    res.json(await fn(req, res));
  } catch (error) {
    next(error);
  }
};

const withRecipient = (req, res, next) =>
  authenticateUser(req, res, (err) => {
    if (err) return next(err);
    try {
      req.recipient = notify.recipientOf(req.user);
      return next();
    } catch (e) {
      res.status(e.statusCode || 403);
      return next(e);
    }
  });

const office = (...keys) => [authenticateManagementUser, requirePermission(...keys)];

// Office actions first, so "/notifications/email-log" etc. are never taken as ids.
router.get("/notification-settings", ...office("settings.manage"), send(() => notify.getNotificationSettings()));
router.put("/notification-settings", ...office("settings.manage"), send((req) => notify.updateNotificationSettings(req.body, { username: req.user.username })));
router.get("/notifications/email-log", ...office("settings.manage"), send((req) => notify.listEmailLog(req.query)));
router.post("/notifications/results-ready", ...office("results.notify_ready"), send((req) => notify.sendResultsReady(req.body || {}, req.user)));
router.post("/notifications/scores-reminder", ...office("results.remind_teachers"), send(() => notify.sendScoresReminder()));

// The caller's own.
router.get("/notifications", withRecipient, send((req) => notify.listNotifications(req.recipient, req.query)));
router.get("/notifications/unread-count", withRecipient, send((req) => notify.unreadCount(req.recipient)));
router.patch("/notifications/read-all", withRecipient, send((req) => notify.markAllRead(req.recipient)));
router.patch("/notifications/:id/read", withRecipient, send((req) => notify.markRead(req.recipient, req.params.id)));

export { router as notificationRouter };
