import { Router } from "express";
import { authCallback, fetchAssignment, fileDelete, fileDownload, files, redirectToAuth, upload, uploadFile } from "../controllers/fileController.js";
import { authenticateUser } from "../utils/middlewares.js";


const router = Router();

router.get("/auth/google", redirectToAuth);
router.get("/oauth/callback", authCallback);
router.get("/download/:fileId", fileDownload);
router.get("/files", files);
router.get("/get-assignment", authenticateUser, fetchAssignment);

router.post("/upload", upload.single('file'), uploadFile);

router.delete("/delete-file/:fileId", authenticateUser, fileDelete)

export {
    router as fileRouter
}