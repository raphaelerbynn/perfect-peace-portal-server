import { Router } from "express";
import { fetchClassTermReport, fetchTermReport, fetchTermsOverview } from "../controllers/academicReportController.js";
import { authorizeRoles } from "../utils/middlewares.js";
import { ADMINISTRATOR, CLASS_TEACHER, HEAD_TEACHER } from "../utils/roles.js";

// B11: academic reports. Mounted in src/index.js behind
// authenticateManagementUser (office tokens only).
//  - School-wide reports (every class): Administrator.
//  - One class's term (drill-down): Administrator, or a Class Teacher for
//    their own class (the service checks assertClassAccess).
// B10: school-wide reports for the Administrator and Head Teacher; one class also for its Class Teacher.
const SCHOOL_WIDE = authorizeRoles(ADMINISTRATOR, HEAD_TEACHER);
const ACADEMIC = authorizeRoles(ADMINISTRATOR, CLASS_TEACHER, HEAD_TEACHER);

const router = Router();

router.get("/reports/academic/terms-overview", SCHOOL_WIDE, fetchTermsOverview);
router.get("/reports/academic/term/:termId", SCHOOL_WIDE, fetchTermReport);
router.get("/reports/academic/term/:termId/class/:classId", ACADEMIC, fetchClassTermReport);

export { router as academicReportRouter };
