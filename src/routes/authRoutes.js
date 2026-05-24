import { Router } from "express";
import { fetchStaffForSignup, resetForgottenPassword, sendStaffPasswordOTP, signin, signinManagement, signup, signupManagement } from "../controllers/authController.js";
import { resetPin, updatePassword, verifyPin } from "../controllers/generalController.js";


const router = Router();

router.post("/signin", signin);
router.post("/signup", signup);

router.post("/signin-management", signinManagement);
router.post("/signup-management", signupManagement);

// Public, minimal (id + name only) staff list for the pre-login signup picker.
router.get("/signup-staff-list", fetchStaffForSignup);

router.get("/send-otp/:userId", sendStaffPasswordOTP);
router.post("/reset-password", resetForgottenPassword);

router.post("/get-pin", resetPin);
router.post("/update-pin", updatePassword);
router.post("/verify-pin", verifyPin);

export {
    router as authRouter
}