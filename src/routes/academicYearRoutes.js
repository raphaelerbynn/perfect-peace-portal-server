import { Router } from "express";
import {
  addAcademicYear,
  addYearTerm,
  editAcademicYear,
  fetchAcademicYear,
  fetchAcademicYears,
  makeAcademicYearCurrent,
  openTerm,
  removeAcademicYear,
  removeTerm,
} from "../controllers/academicYearController.js";
import { authorizeRoles } from "../utils/middlewares.js";
import { OFFICE_ROLES } from "../utils/roles.js";

// B7: academic years and the terms in them. Mounted in src/index.js behind
// authenticateManagementUser (management tokens only). Reading is open to every
// office role (term pickers show the year); changing is Administrator only,
// like the existing term settings.
const ADMIN_ONLY = authorizeRoles("Administrator");
const ALL_ROLES = authorizeRoles(...OFFICE_ROLES); // B10: Head Teacher reads, never changes

const router = Router();

router.get("/academic-years", ALL_ROLES, fetchAcademicYears);
router.get("/academic-years/:id", ALL_ROLES, fetchAcademicYear);
router.post("/academic-years", ADMIN_ONLY, addAcademicYear);
router.patch("/academic-years/:id", ADMIN_ONLY, editAcademicYear);
router.delete("/academic-years/:id", ADMIN_ONLY, removeAcademicYear);
router.post("/academic-years/:id/set-current", ADMIN_ONLY, makeAcademicYearCurrent);
router.post("/academic-years/:id/terms", ADMIN_ONLY, addYearTerm);
router.post("/terms/:id/activate", ADMIN_ONLY, openTerm);
router.delete("/terms/:id", ADMIN_ONLY, removeTerm);

export { router as academicYearRouter };
