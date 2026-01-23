import { Router } from "express";
import { sendSMS } from "../controllers/communicationController.js";

const router = Router();

router.post("/send-sms", sendSMS);


export {
    router as communicationRouter
}