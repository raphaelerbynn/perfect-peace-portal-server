import { Router } from "express";
import {
  fetchOneStaffSummary,
  fetchStaffDay,
  fetchStaffSummary,
  saveStaffAttendance,
} from "../controllers/staffAttendanceController.js";
import { authorizeRoles } from "../utils/middlewares.js";
import { ADMINISTRATOR, HEAD_TEACHER } from "../utils/roles.js";

// B9: staff attendance. Mounted in src/index.js behind
// authenticateManagementUser (office tokens only). Marking and reading are
// Administrator only (default until the client says who else takes it).
// B10: the Head Teacher keeps the staff register too.
const STAFF_REGISTER = authorizeRoles(ADMINISTRATOR, HEAD_TEACHER);

const router = Router();

router.get("/staff-attendance", STAFF_REGISTER, fetchStaffDay);
router.post("/staff-attendance", STAFF_REGISTER, saveStaffAttendance);
// /summary before /:teacherId/summary (it is not a teacher id).
router.get("/staff-attendance/summary", STAFF_REGISTER, fetchStaffSummary);
router.get("/staff-attendance/:teacherId/summary", STAFF_REGISTER, fetchOneStaffSummary);

export { router as staffAttendanceRouter };
