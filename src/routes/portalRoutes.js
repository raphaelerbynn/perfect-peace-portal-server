import { Router } from "express";
import { fetchNews, fetchUserDetails } from "../controllers/generalController.js";
import { fetchClass } from "../controllers/onlyTeacherController.js";
import { fetchSubject } from "../controllers/subjectController.js";
import { fetchPortalTimetable } from "../controllers/timetableController.js";
import { fetchMyPhoto } from "../controllers/mediaController.js";
import { authenticateUser } from "../utils/middlewares.js";
import { portalTerms, pupilAttendance } from "../services/portalAttendance.js";

// Portal (student / teacher) read routes that share a path with management
// routes in generalRouter (/news, /class, /subject, /user-details).
//
// generalRouter is mounted behind `authenticateManagementUser`, which rejects
// any token without a `category` claim (403). Portal tokens ({ id, userRole })
// therefore could never reach these shared paths. This router is mounted
// BEFORE the management router:
//   - portal token  -> handled here (read-only).
//   - management token -> `next("router")` skips this router entirely, so the
//     request falls through to generalRouter and its role checks unchanged.
//   - no / invalid token -> 401 from authenticateUser.
const PORTAL_ROLES = new Set(["STU", "STAFF"]);

const portalOnly = (req, res, next) =>
  authenticateUser(req, res, (err) => {
    if (err) return next(err);
    if (req.user?.category) return next("router"); // management token
    if (!PORTAL_ROLES.has(req.user?.userRole)) {
      res.status(403);
      return next(new Error("You do not have permission to perform this action"));
    }
    return next();
  });

const staffOnly = (req, res, next) => {
  if (req.user?.userRole !== "STAFF") {
    res.status(403);
    return next(new Error("You do not have permission to perform this action"));
  }
  return next();
};

const router = Router();

// Only these paths: other requests must not be authenticated (or rejected) here.
router.use(["/user-details", "/news", "/class", "/subject", "/portal/timetable", "/portal/photo", "/portal/terms", "/portal/attendance"], portalOnly);

router.get("/user-details", fetchUserDetails);
router.get("/news", fetchNews);
// Teachers pick a class/subject when uploading assignments.
router.get("/class", staffOnly, fetchClass);
router.get("/subject", staffOnly, fetchSubject);
// B3: a pupil's class timetable, or a teacher's own lessons (open term).
router.get("/portal/timetable", fetchPortalTimetable);
// B17: the signed-in pupil's or teacher's own photo (by token id).
router.get("/portal/photo", fetchMyPhoto);
// Attendance page: terms for the picker, and the signed-in pupil's own
// register (by token id; teachers refused).
const pupilOnly = (req, res, next) => {
  if (req.user?.userRole !== "STU") {
    res.status(403);
    return next(new Error("You do not have permission to perform this action"));
  }
  return next();
};
const send = (fn) => async (req, res, next) => {
  try {
    res.json(await fn(req));
  } catch (error) {
    next(error);
  }
};
router.get("/portal/terms", send(() => portalTerms()));
router.get("/portal/attendance", pupilOnly, send((req) => pupilAttendance(req.user.id, req.query.termId)));

export { router as portalRouter, portalOnly, PORTAL_ROLES };
