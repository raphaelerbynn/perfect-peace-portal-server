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
import { requirePermission } from "../utils/middlewares.js";

// B7: academic years and the terms in them. Mounted in src/index.js behind
// authenticateManagementUser (management tokens only). Reading: terms.view
// (every system role; term pickers show the year); changing: terms.manage
// (Administrator), like the existing term settings.
const MANAGE = requirePermission("terms.manage");
const READ = requirePermission("terms.view");

const router = Router();

router.get("/academic-years", READ, fetchAcademicYears);
router.get("/academic-years/:id", READ, fetchAcademicYear);
router.post("/academic-years", MANAGE, addAcademicYear);
router.patch("/academic-years/:id", MANAGE, editAcademicYear);
router.delete("/academic-years/:id", MANAGE, removeAcademicYear);
router.post("/academic-years/:id/set-current", MANAGE, makeAcademicYearCurrent);
router.post("/academic-years/:id/terms", MANAGE, addYearTerm);
router.post("/terms/:id/activate", MANAGE, openTerm);
router.delete("/terms/:id", MANAGE, removeTerm);

export { router as academicYearRouter };
