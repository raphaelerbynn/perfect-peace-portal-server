import { Router } from "express";
import { fetchClassTermReport, fetchTermReport, fetchTermsOverview } from "../controllers/academicReportController.js";
import { requirePermission } from "../utils/middlewares.js";

// B11: academic reports. Mounted in src/index.js behind
// authenticateManagementUser (office tokens only).
//  - School-wide reports (every class): reports.academic_school (Administrator).
//  - One class's term (drill-down): reports.academic_class (Administrator, Class
//    Teacher); the service limits it to the login's own class unless the role
//    holds academics.all_classes (assertClassAccess).
const SCHOOL_WIDE = requirePermission("reports.academic_school");
const ONE_CLASS = requirePermission("reports.academic_class");

const router = Router();

router.get("/reports/academic/terms-overview", SCHOOL_WIDE, fetchTermsOverview);
router.get("/reports/academic/term/:termId", SCHOOL_WIDE, fetchTermReport);
router.get("/reports/academic/term/:termId/class/:classId", ONE_CLASS, fetchClassTermReport);

export { router as academicReportRouter };
