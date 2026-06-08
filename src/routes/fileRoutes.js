import { Router } from "express";
import { authCallback, fetchAssignment, fileDelete, fileDownload, files, redirectToAuth, upload, uploadFile } from "../controllers/fileController.js";
import { authenticateUser } from "../utils/middlewares.js";


const router = Router();

// Google OAuth setup endpoints must stay public (Google redirects to the callback).
router.get("/auth/google", redirectToAuth);
router.get("/oauth/callback", authCallback);
// BE-2: these were fully PUBLIC — anyone could upload to Drive, list every file,
// and download any file by id. Require a valid token (matches get-assignment /
// delete-file). authenticateUser accepts both portal and management tokens.
router.get("/download/:fileId", authenticateUser, fileDownload);
router.get("/files", authenticateUser, files);
router.get("/get-assignment", authenticateUser, fetchAssignment);

router.post("/upload", authenticateUser, upload.single('file'), uploadFile);

router.delete("/delete-file/:fileId", authenticateUser, fileDelete)

export {
    router as fileRouter
}