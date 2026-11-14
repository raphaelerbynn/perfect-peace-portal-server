import { Router } from "express";
import { documentHandlers, photoHandlers, studentScopeMw } from "../controllers/mediaController.js";
import { uploadOne } from "../services/storage.js";
import { authorizeRoles } from "../utils/middlewares.js";

// B17: photos and documents on pupil and staff records (office tokens only:
// mounted behind authenticateManagementUser in index.js, after generalRouter).
// Order on every write: role -> record scope -> read the upload. Nothing is
// served by a public path; each file is streamed by owner + id.
const ADMIN_ONLY = authorizeRoles("Administrator");
const ACADEMIC = authorizeRoles("Administrator", "Class Teacher");

const studentPhoto = photoHandlers("STUDENT");
const staffPhoto = photoHandlers("STAFF");
const studentDocs = documentHandlers("STUDENT");
const staffDocs = documentHandlers("STAFF");

const router = Router();

// Pupils: Administrator, or the Class Teacher of the pupil's own class.
router.get("/students/:id/photo", ACADEMIC, studentScopeMw, studentPhoto.get);
router.post("/students/:id/photo", ACADEMIC, studentScopeMw, uploadOne("photo"), studentPhoto.put);
router.delete("/students/:id/photo", ACADEMIC, studentScopeMw, studentPhoto.remove);
router.get("/students/:id/documents", ACADEMIC, studentScopeMw, studentDocs.list);
router.post("/students/:id/documents", ACADEMIC, studentScopeMw, uploadOne("document"), studentDocs.add);
router.get("/students/:id/documents/:docId/file", ACADEMIC, studentScopeMw, studentDocs.file);
router.delete("/students/:id/documents/:docId", ACADEMIC, studentScopeMw, studentDocs.remove);

// Staff: Administrator only (contracts, Ghana Card, bank details).
router.get("/staff/:id/photo", ADMIN_ONLY, staffPhoto.get);
router.post("/staff/:id/photo", ADMIN_ONLY, uploadOne("photo"), staffPhoto.put);
router.delete("/staff/:id/photo", ADMIN_ONLY, staffPhoto.remove);
router.get("/staff/:id/documents", ADMIN_ONLY, staffDocs.list);
router.post("/staff/:id/documents", ADMIN_ONLY, uploadOne("document"), staffDocs.add);
router.get("/staff/:id/documents/:docId/file", ADMIN_ONLY, staffDocs.file);
router.delete("/staff/:id/documents/:docId", ADMIN_ONLY, staffDocs.remove);

export { router as mediaRouter };
