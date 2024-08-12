import { Router } from "express";
import { resetForgottenPassword, sendStaffPasswordOTP, signin, signinManagement, signup, signupManagement } from "../controllers/authController.js";


const router = Router();

router.post("/signin", signin);
router.post("/signup", signup);

router.post("/signin-management", signinManagement);
router.post("/signup-management", signupManagement);

router.get("/send-otp/:userId", sendStaffPasswordOTP);
router.post("/reset-password", resetForgottenPassword);

export {
    router as authRouter
}