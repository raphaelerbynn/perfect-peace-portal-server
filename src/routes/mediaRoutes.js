import { Router } from "express";
import { documentHandlers, photoHandlers, studentScopeMw } from "../controllers/mediaController.js";
import { uploadOne } from "../services/storage.js";
import { requirePermission } from "../utils/middlewares.js";

// B17: photos and documents on pupil and staff records (office tokens only:
// mounted behind authenticateManagementUser in index.js, after generalRouter).
// Order on every write: role -> record scope -> read the upload. Nothing is
// served by a public path; each file is streamed by owner + id.
// B10: pupils' files: students.view_files / students.manage_files (Administrator,
// Class Teacher), limited to the login's own class without
// academics.all_classes. Staff: the photo with the staff list (staff.view),
// everything else staff.files (Administrator).
const PUPIL_READ = requirePermission("students.view_files");
const PUPIL_WRITE = requirePermission("students.manage_files");
const STAFF_PHOTO_READ = requirePermission("staff.view");
const STAFF_FILES = requirePermission("staff.files");

const studentPhoto = photoHandlers("STUDENT");
const staffPhoto = photoHandlers("STAFF");
const studentDocs = documentHandlers("STUDENT");
const staffDocs = documentHandlers("STAFF");

const router = Router();

// Pupils: every pupil with academics.all_classes, else the login's own class.
router.get("/students/:id/photo", PUPIL_READ, studentScopeMw, studentPhoto.get);
router.post("/students/:id/photo", PUPIL_WRITE, studentScopeMw, uploadOne("photo"), studentPhoto.put);
router.delete("/students/:id/photo", PUPIL_WRITE, studentScopeMw, studentPhoto.remove);
router.get("/students/:id/documents", PUPIL_READ, studentScopeMw, studentDocs.list);
router.post("/students/:id/documents", PUPIL_WRITE, studentScopeMw, uploadOne("document"), studentDocs.add);
router.get("/students/:id/documents/:docId/file", PUPIL_READ, studentScopeMw, studentDocs.file);
router.delete("/students/:id/documents/:docId", PUPIL_WRITE, studentScopeMw, studentDocs.remove);

// Staff: staff.files only (contracts, Ghana Card, bank details); the photo
// shows on the staff list (staff.view).
router.get("/staff/:id/photo", STAFF_PHOTO_READ, staffPhoto.get);
router.post("/staff/:id/photo", STAFF_FILES, uploadOne("photo"), staffPhoto.put);
router.delete("/staff/:id/photo", STAFF_FILES, staffPhoto.remove);
router.get("/staff/:id/documents", STAFF_FILES, staffDocs.list);
router.post("/staff/:id/documents", STAFF_FILES, uploadOne("document"), staffDocs.add);
router.get("/staff/:id/documents/:docId/file", STAFF_FILES, staffDocs.file);
router.delete("/staff/:id/documents/:docId", STAFF_FILES, staffDocs.remove);

export { router as mediaRouter };
