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
//
// Security review: these are portal routes. Pupils (STU) may read and download
// their class's assignments; only teachers (STAFF) may list Drive, upload or
// delete — and the handlers check the file is an assignment (and, to delete,
// the teacher's own). Office (management) tokens are refused.
const portalRole = (...roles) => (req, res, next) =>
  authenticateUser(req, res, (err) => {
    if (err) return next(err);
    if (req.user?.category || !roles.includes(req.user?.userRole)) {
      res.status(403);
      return next(new Error("You do not have permission to perform this action"));
    }
    return next();
  });

router.get("/download/:fileId", portalRole("STU", "STAFF"), fileDownload);
router.get("/files", portalRole("STAFF"), files);
router.get("/get-assignment", portalRole("STU", "STAFF"), fetchAssignment);

router.post("/upload", portalRole("STAFF"), upload.single('file'), uploadFile);

router.delete("/delete-file/:fileId", portalRole("STAFF"), fileDelete)

export {
    router as fileRouter
}