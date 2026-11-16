import { Router } from "express";
import {
  fetchKgRatings,
  fetchMyClasses,
  fetchRegister,
  fetchScores,
  updateKgRatings,
  updateRegister,
  updateScores,
} from "../controllers/teacherController.js";
import { authenticateUser } from "../utils/middlewares.js";

// B2: teacher portal routes. Portal STAFF tokens only; every handler also
// checks the teacher's scope (services/teacherScope.js). Office users keep
// using /mark-attendance and /upsert-single-subject-result.
const staffToken = (req, res, next) =>
  authenticateUser(req, res, (err) => {
    if (err) return next(err);
    if (req.user?.category || req.user?.userRole !== "STAFF") {
      res.status(403);
      return next(new Error("Only teachers can use this. Sign in to the teacher portal."));
    }
    return next();
  });

const router = Router();
router.use("/teacher", staffToken);

router.get("/teacher/my-classes", fetchMyClasses);
router.get("/teacher/register", fetchRegister);
router.post("/teacher/register", updateRegister);
router.get("/teacher/scores", fetchScores);
router.post("/teacher/scores", updateScores);
// KG / nursery: the report card's development ratings, one pupil at a time.
router.get("/teacher/kg-ratings", fetchKgRatings);
router.post("/teacher/kg-ratings", updateKgRatings);

export { router as teacherRouter, staffToken };
