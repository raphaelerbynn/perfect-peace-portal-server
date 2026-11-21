import { Router } from "express";
import { sendSMS } from "../controllers/communicationController.js";
import { requirePermission } from "../utils/middlewares.js";

// Mounted at /communication behind authenticateManagementUser (src/index.js).

const router = Router();

router.post("/send-sms", requirePermission("sms.send"), sendSMS);


export {
    router as communicationRouter
}