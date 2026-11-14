import { Router } from "express";
import { fetchClassTermReport, fetchTermReport, fetchTermsOverview } from "../controllers/academicReportController.js";
import { authorizeRoles } from "../utils/middlewares.js";

// B11: academic reports. Mounted in src/index.js behind
// authenticateManagementUser (office tokens only).
//  - School-wide reports (every class): Administrator.
//  - One class's term (drill-down): Administrator, or a Class Teacher for
//    their own class (the service checks assertClassAccess).
const ADMIN_ONLY = authorizeRoles("Administrator");
const ACADEMIC = authorizeRoles("Administrator", "Class Teacher");

const router = Router();

router.get("/reports/academic/terms-overview", ADMIN_ONLY, fetchTermsOverview);
router.get("/reports/academic/term/:termId", ADMIN_ONLY, fetchTermReport);
router.get("/reports/academic/term/:termId/class/:classId", ACADEMIC, fetchClassTermReport);

export { router as academicReportRouter };
