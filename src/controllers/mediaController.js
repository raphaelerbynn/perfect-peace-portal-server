// B17: photo and document handlers (thin; rules in services/media.js).
import {
  addDocument,
  assertStudentAccess,
  getDocumentFile,
  getPhoto,
  listDocuments,
  removeDocument,
  removePhoto,
  setPhoto,
} from "../services/media.js";
import { sendStoredFile } from "../services/storage.js";

const wrap = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    next(error);
  }
};

// Runs BEFORE multer: a Class Teacher asking about another class's pupil is
// refused without the server reading the upload.
// wrap() swallows next(); the scope middleware must continue on success.
export const studentScopeMw = async (req, res, next) => {
  try {
    await assertStudentAccess(req.user, req.params.id);
    next();
  } catch (error) {
    next(error);
  }
};

const who = (req) => req.user?.username || req.user?.category || null;

export const photoHandlers = (ownerType) => ({
  get: wrap(async (req, res) => {
    const f = await getPhoto(ownerType, req.params.id);
    await sendStoredFile(res, { key: f.key, mime: f.mime, name: `photo.${f.key.split(".").pop()}` });
  }),
  put: wrap(async (req, res) => res.json(await setPhoto(ownerType, req.params.id, req.file))),
  remove: wrap(async (req, res) => res.json(await removePhoto(ownerType, req.params.id))),
});

export const documentHandlers = (ownerType) => ({
  list: wrap(async (req, res) => res.json(await listDocuments(ownerType, req.params.id))),
  add: wrap(async (req, res) => res.json(await addDocument(ownerType, req.params.id, req.body, req.file, { uploadedBy: who(req) }))),
  file: wrap(async (req, res) => {
    const f = await getDocumentFile(ownerType, req.params.id, req.params.docId);
    await sendStoredFile(res, f);
  }),
  remove: wrap(async (req, res) => res.json(await removeDocument(ownerType, req.params.id, req.params.docId))),
});

// Portal: a pupil's or teacher's own photo (by token id, never a parameter).
export const fetchMyPhoto = wrap(async (req, res) => {
  const ownerType = req.user?.userRole === "STU" ? "STUDENT" : "STAFF";
  const f = await getPhoto(ownerType, req.user?.id);
  await sendStoredFile(res, { key: f.key, mime: f.mime, name: `photo.${f.key.split(".").pop()}` });
});
