import { Router } from "express";
import { signin, signinManagement, signup, signupManagement } from "../controllers/authController.js";


const router = Router();

router.post("/signin", signin);
router.post("/signup", signup);

router.post("/signin-management", signinManagement);
router.post("/signup-management", signupManagement);

export {
    router as authRouter
}