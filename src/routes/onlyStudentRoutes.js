import { Router } from "express";
import { fetchFeeCheck, fetchNurseryResults, fetchResults, fetchResultDetails, fetchFeeList } from "../controllers/onlyStudentsController.js";
import { authenticateUser } from "../utils/middlewares.js";

const router = Router();

router.get("/result", authenticateUser, fetchResults);
router.get("/result-details", authenticateUser, fetchResultDetails);
router.get("/nursery-result", authenticateUser, fetchNurseryResults);
router.get("/feecheck", authenticateUser, fetchFeeCheck);
router.get("/fees", authenticateUser, fetchFeeList);


export {router as studentRouter};