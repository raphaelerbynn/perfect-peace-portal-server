import { Router } from "express";
import { fetchFeeCheck, fetchNurseryResults, fetchResults, fetchResultDetails, fetchLastPaid } from "../controllers/onlyStudentsController.js";
import { FeeCheck, Student } from "../models/index.js";
import { authenticateUser } from "../utils/middlewares.js";

const router = Router();

// Security review: these read the signed-in PUPIL's own records by token id.
// A teacher's portal token (STAFF) has an id too, so it would have read the
// pupil with the same number: pupils only.
const pupilOnly = (req, res, next) =>
  authenticateUser(req, res, (err) => {
    if (err) return next(err);
    if (req.user?.category || req.user?.userRole !== "STU") {
      res.status(403);
      return next(new Error("You do not have permission to perform this action"));
    }
    return next();
  });

// The fees lockout (portal App.js) was only in the browser: the API still
// returned results to a pupil owing more than the limit. Same rule here.
const OWING_LIMIT = 100;
const feesLockout = async (req, res, next) => {
  try {
    const [check] = await FeeCheck.findAll({ attributes: ["value"], raw: true });
    if (String(check?.value ?? "").toLowerCase() !== "true") return next();
    const pupil = await Student.findOne({ where: { studentId: req.user.id }, attributes: ["feesOwing"], raw: true });
    // Locked at GH¢ 100 or more (the portal shows the same rule).
    if (Number(pupil?.feesOwing) >= OWING_LIMIT) {
      return res.status(403).json({ message: "Results are hidden while school fees are owing. Please see the school office.", code: "FEES_OWING" });
    }
    return next();
  } catch (error) {
    return next(error);
  }
};

router.get("/result", pupilOnly, feesLockout, fetchResults);
router.get("/result-details", pupilOnly, feesLockout, fetchResultDetails);
router.get("/nursery-result", pupilOnly, feesLockout, fetchNurseryResults);
router.get("/feecheck", pupilOnly, fetchFeeCheck);
router.get("/last-fee-paid", pupilOnly, fetchLastPaid);


export { router as studentRouter, OWING_LIMIT };
