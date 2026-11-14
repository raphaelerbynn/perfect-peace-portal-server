import { Router } from "express";
import { fetchStaffForSignup, resetForgottenPassword, sendStaffPasswordOTP, signin, signinManagement, signup, signupManagement } from "../controllers/authController.js";
import { resetPin, updatePassword, verifyPin } from "../controllers/generalController.js";
import { authenticateManagementUser, authorizeRoles } from "../utils/middlewares.js";

// Office logins are created by an Administrator, not self-registered: open
// sign-up let anyone create an Accountant (full fee access) or Class Teacher
// login for any staff member (security review, 2026-11-08).
const adminOnly = [authenticateManagementUser, authorizeRoles("Administrator")];


const router = Router();

router.post("/signin", signin);
router.post("/signup", signup);

router.post("/signin-management", signinManagement);
router.post("/signup-management", ...adminOnly, signupManagement);

// Minimal (id + name) staff list for the "Office logins" picker: admin only now.
router.get("/signup-staff-list", ...adminOnly, fetchStaffForSignup);

router.get("/send-otp/:userId", sendStaffPasswordOTP);
router.post("/reset-password", resetForgottenPassword);

router.post("/get-pin", resetPin);
router.post("/update-pin", updatePassword);
router.post("/verify-pin", verifyPin);

export {
    router as authRouter
}