import { Router } from "express";
import { documentHandlers, photoHandlers, studentScopeMw } from "../controllers/mediaController.js";
import { uploadOne } from "../services/storage.js";
import { authorizeRoles } from "../utils/middlewares.js";
import { ADMINISTRATOR, CLASS_TEACHER, HEAD_TEACHER } from "../utils/roles.js";

// B17: photos and documents on pupil and staff records (office tokens only:
// mounted behind authenticateManagementUser in index.js, after generalRouter).
// Order on every write: role -> record scope -> read the upload. Nothing is
// served by a public path; each file is streamed by owner + id.
// B10: the Head Teacher views every pupil's photo and documents and staff
// photos, but doesn't change pupil or staff records.
const ADMIN_ONLY = authorizeRoles(ADMINISTRATOR);
const ACADEMIC = authorizeRoles(ADMINISTRATOR, CLASS_TEACHER);
const ACADEMIC_READ = authorizeRoles(ADMINISTRATOR, CLASS_TEACHER, HEAD_TEACHER);
const STAFF_PHOTO_READ = authorizeRoles(ADMINISTRATOR, HEAD_TEACHER);

const studentPhoto = photoHandlers("STUDENT");
const staffPhoto = photoHandlers("STAFF");
const studentDocs = documentHandlers("STUDENT");
const staffDocs = documentHandlers("STAFF");

const router = Router();

// Pupils: Administrator, or the Class Teacher of the pupil's own class;
// the Head Teacher reads any pupil's.
router.get("/students/:id/photo", ACADEMIC_READ, studentScopeMw, studentPhoto.get);
router.post("/students/:id/photo", ACADEMIC, studentScopeMw, uploadOne("photo"), studentPhoto.put);
router.delete("/students/:id/photo", ACADEMIC, studentScopeMw, studentPhoto.remove);
router.get("/students/:id/documents", ACADEMIC_READ, studentScopeMw, studentDocs.list);
router.post("/students/:id/documents", ACADEMIC, studentScopeMw, uploadOne("document"), studentDocs.add);
router.get("/students/:id/documents/:docId/file", ACADEMIC_READ, studentScopeMw, studentDocs.file);
router.delete("/students/:id/documents/:docId", ACADEMIC, studentScopeMw, studentDocs.remove);

// Staff: Administrator only (contracts, Ghana Card, bank details); the Head
// Teacher sees the photo on the staff list.
router.get("/staff/:id/photo", STAFF_PHOTO_READ, staffPhoto.get);
router.post("/staff/:id/photo", ADMIN_ONLY, uploadOne("photo"), staffPhoto.put);
router.delete("/staff/:id/photo", ADMIN_ONLY, staffPhoto.remove);
router.get("/staff/:id/documents", ADMIN_ONLY, staffDocs.list);
router.post("/staff/:id/documents", ADMIN_ONLY, uploadOne("document"), staffDocs.add);
router.get("/staff/:id/documents/:docId/file", ADMIN_ONLY, staffDocs.file);
router.delete("/staff/:id/documents/:docId", ADMIN_ONLY, staffDocs.remove);

export { router as mediaRouter };
