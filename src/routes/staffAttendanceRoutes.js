import { Router } from "express";
import {
  fetchOneStaffSummary,
  fetchStaffDay,
  fetchStaffSummary,
  saveStaffAttendance,
} from "../controllers/staffAttendanceController.js";
import { requirePermission } from "../utils/middlewares.js";

// B9: staff attendance. Mounted in src/index.js behind
// authenticateManagementUser (office tokens only). Reading:
// staff_attendance.view, marking: staff_attendance.mark (both Administrator by
// default; a custom role can take the register).
const READ = requirePermission("staff_attendance.view");
const MARK = requirePermission("staff_attendance.mark");

const router = Router();

router.get("/staff-attendance", READ, fetchStaffDay);
router.post("/staff-attendance", MARK, saveStaffAttendance);
// /summary before /:teacherId/summary (it is not a teacher id).
router.get("/staff-attendance/summary", READ, fetchStaffSummary);
router.get("/staff-attendance/:teacherId/summary", READ, fetchOneStaffSummary);

export { router as staffAttendanceRouter };
