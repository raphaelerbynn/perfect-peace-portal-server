import { Router } from "express";
import {
  getNextAdmissionNoSuggestion,
  getPublicSchool,
  getSchoolLogoKey,
  getSchoolSettingsForAdmin,
  previewAdmissionFormat,
  removeSchoolLogo,
  setSchoolLogo,
  updateSchoolSettings,
} from "../services/school.js";
import { sendStoredFile, uploadOne } from "../services/storage.js";
import { authenticateManagementUser, authorizeRoles } from "../utils/middlewares.js";
import { ADMINISTRATOR } from "../utils/roles.js";

// B18: school branding. Mounted early in index.js because GET /school and
// GET /school/logo are PUBLIC (the sign-in screens show the school's name and
// logo). Every other route here authenticates per route: office token +
// Administrator. Only these paths are handled; anything else falls through.
const ADMIN = [authenticateManagementUser, authorizeRoles(ADMINISTRATOR)];

const wrap = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    next(error);
  }
};
const who = (req) => req.user?.username || req.user?.category || null;

const router = Router();

router.get(
  "/school",
  wrap(async (req, res) => {
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json(await getPublicSchool());
  })
);
router.get(
  "/school/logo",
  wrap(async (req, res) => {
    const key = await getSchoolLogoKey();
    // Shown by <img> on the apps' own origins: allow cross-origin embedding.
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    await sendStoredFile(res, { key, name: `logo.${key.split(".").pop()}`, cache: "public, max-age=3600" });
  })
);

router.get("/school/settings", ...ADMIN, wrap(async (req, res) => res.json(await getSchoolSettingsForAdmin())));
router.put("/school", ...ADMIN, wrap(async (req, res) => res.json(await updateSchoolSettings(req.body, { username: who(req) }))));
router.post(
  "/school/logo",
  ...ADMIN,
  uploadOne("logo"),
  wrap(async (req, res) => res.json(await setSchoolLogo(req.file, { username: who(req) })))
);
router.delete("/school/logo", ...ADMIN, wrap(async (req, res) => res.json(await removeSchoolLogo({ username: who(req) }))));
router.get("/school/admission-preview", ...ADMIN, wrap(async (req, res) => res.json(await previewAdmissionFormat(req.query.format))));
// The number the Add student form suggests (the real one is taken on save).
router.get("/students/next-admission-no", ...ADMIN, wrap(async (req, res) => res.json(await getNextAdmissionNoSuggestion())));

export { router as schoolRouter };
