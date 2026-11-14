import { Router } from "express";
import {
  fetchOneStaffSummary,
  fetchStaffDay,
  fetchStaffSummary,
  saveStaffAttendance,
} from "../controllers/staffAttendanceController.js";
import { authorizeRoles } from "../utils/middlewares.js";

// B9: staff attendance. Mounted in src/index.js behind
// authenticateManagementUser (office tokens only). Marking and reading are
// Administrator only (default until the client says who else takes it).
const ADMIN_ONLY = authorizeRoles("Administrator");

const router = Router();

router.get("/staff-attendance", ADMIN_ONLY, fetchStaffDay);
router.post("/staff-attendance", ADMIN_ONLY, saveStaffAttendance);
// /summary before /:teacherId/summary (it is not a teacher id).
router.get("/staff-attendance/summary", ADMIN_ONLY, fetchStaffSummary);
router.get("/staff-attendance/:teacherId/summary", ADMIN_ONLY, fetchOneStaffSummary);

export { router as staffAttendanceRouter };
