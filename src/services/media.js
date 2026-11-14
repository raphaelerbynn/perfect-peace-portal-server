// B17: photos and documents on pupil and staff records.
//
// Who may do what (client question open; defaults):
//   - pupil photo + documents: Administrator, or the Class Teacher of the
//     pupil's own class (assertClassAccess);
//   - staff photo + documents: Administrator only;
//   - portal: a pupil or teacher sees only their own photo.
// The storage key never leaves the server: lists return ids, and files are
// streamed by owner + id, so a document id from another record is a 404.
import { Op } from "sequelize";
import sequelize from "../config/database.js";
import { Document, Student, Teacher } from "../models/index.js";
import { AppError } from "../utils/errorHandling.js";
import { assertClassAccess } from "./attendance.js";
import { MIME_FOR_EXT, saveUpload, storage } from "./storage.js";

export const STUDENT_DOC_TYPES = {
  BIRTH_CERTIFICATE: "Birth certificate",
  PREVIOUS_REPORT: "Previous school report",
  TRANSFER_LETTER: "Transfer letter",
  MEDICAL: "Medical / immunisation record",
  GUARDIAN_ID: "Guardian ID",
  ADMISSION_LETTER: "Admission letter",
  OTHER: "Other",
};
export const STAFF_DOC_TYPES = {
  CERTIFICATE: "Certificate / qualification",
  APPOINTMENT_LETTER: "Appointment letter",
  CONTRACT: "Contract",
  GHANA_CARD: "Ghana Card",
  SSNIT: "SSNIT",
  TIN: "TIN",
  BANK_DETAILS: "Bank details",
  OTHER: "Other",
};
const OWNERS = {
  STUDENT: { model: Student, idField: "studentId", types: STUDENT_DOC_TYPES, label: "Student" },
  STAFF: { model: Teacher, idField: "teacherId", types: STAFF_DOC_TYPES, label: "Staff member" },
};
export const MAX_DOCUMENTS_PER_OWNER = 50;

export const parseId = (value, label = "Record") => {
  const s = String(value ?? "");
  if (!/^[1-9]\d{0,9}$/.test(s)) throw new AppError(`${label} not found`, 404);
  return Number(s);
};

// The owner row (not archived), or 404.
const loadOwner = async (ownerType, id, { transaction, lock } = {}) => {
  const o = OWNERS[ownerType];
  const row = await o.model.findOne({
    where: { [o.idField]: id, isDeleted: { [Op.not]: true } },
    attributes: ownerType === "STUDENT" ? ["studentId", "class", "classId", "photoKey", "photoThumbKey"] : ["teacherId", "photoKey", "photoThumbKey"],
    raw: true,
    transaction,
    ...(lock && transaction ? { lock: transaction.LOCK.UPDATE } : {}),
  });
  if (!row) throw new AppError(`${o.label} not found`, 404);
  return row;
};

// Office access to one pupil: Administrator, or that pupil's Class Teacher.
export const assertStudentAccess = async (user, studentId) => {
  const pupil = await loadOwner("STUDENT", parseId(studentId, "Student"));
  if (user?.category === "Administrator") return pupil;
  if (user?.category !== "Class Teacher") throw new AppError("You do not have permission to perform this action", 403);
  try {
    await assertClassAccess(user, pupil.class);
  } catch (e) {
    throw new AppError("You can only see pupils in your own class", 403);
  }
  return pupil;
};

// --- Photos --------------------------------------------------------------
// size "thumb": the 128px square (photos uploaded before thumbnails existed
// fall back to the full photo).
export const getPhoto = async (ownerType, id, { size } = {}) => {
  const row = await loadOwner(ownerType, parseId(id, OWNERS[ownerType].label));
  if (!row.photoKey) throw new AppError("No photo yet", 404);
  const key = size === "thumb" && row.photoThumbKey ? row.photoThumbKey : row.photoKey;
  return { key, mime: MIME_FOR_EXT[key.split(".").pop()] };
};

const removeAll = (keys) => Promise.all(keys.filter(Boolean).map((k) => storage.remove(k)));

// Save the new file, point the record at it, then remove the old file. If the
// database write fails the new file is removed again (no orphans).
export const setPhoto = async (ownerType, id, file) => {
  const o = OWNERS[ownerType];
  const ownerId = parseId(id, o.label);
  await loadOwner(ownerType, ownerId); // 404 before writing anything
  const saved = await saveUpload(file, "photo");
  let old = [];
  try {
    await sequelize.transaction(async (t) => {
      const row = await loadOwner(ownerType, ownerId, { transaction: t, lock: true });
      old = [row.photoKey, row.photoThumbKey];
      await o.model.update({ photoKey: saved.key, photoThumbKey: saved.thumbKey }, { where: { [o.idField]: ownerId }, transaction: t });
    });
  } catch (e) {
    await removeAll([saved.key, saved.thumbKey]);
    throw e;
  }
  await removeAll(old.filter((k) => k !== saved.key && k !== saved.thumbKey));
  return { hasPhoto: true, mime: saved.mime, size: saved.size };
};

export const removePhoto = async (ownerType, id) => {
  const o = OWNERS[ownerType];
  const ownerId = parseId(id, o.label);
  let old = [];
  await sequelize.transaction(async (t) => {
    const row = await loadOwner(ownerType, ownerId, { transaction: t, lock: true });
    old = [row.photoKey, row.photoThumbKey];
    if (row.photoKey || row.photoThumbKey) {
      await o.model.update({ photoKey: null, photoThumbKey: null }, { where: { [o.idField]: ownerId }, transaction: t });
    }
  });
  await removeAll(old);
  return { hasPhoto: false };
};

// --- Documents -----------------------------------------------------------
// What the browser sees: never the storage key.
const PUBLIC_DOC_FIELDS = ["documentId", "ownerType", "ownerId", "docType", "title", "mime", "sizeBytes", "originalName", "uploadedBy", "createdAt"];
const toPublicDoc = (d, types) => {
  const out = {};
  for (const k of PUBLIC_DOC_FIELDS) out[k] = d[k];
  out.docTypeLabel = types[d.docType] || d.docType;
  return out;
};

export const docTypesFor = (ownerType) =>
  Object.entries(OWNERS[ownerType].types).map(([value, label]) => ({ value, label }));

export const listDocuments = async (ownerType, id) => {
  const o = OWNERS[ownerType];
  const ownerId = parseId(id, o.label);
  await loadOwner(ownerType, ownerId);
  const rows = await Document.findAll({
    where: { ownerType, ownerId },
    attributes: PUBLIC_DOC_FIELDS,
    order: [["createdAt", "DESC"], ["documentId", "DESC"]],
    raw: true,
  });
  return { documents: rows.map((d) => toPublicDoc(d, o.types)), docTypes: docTypesFor(ownerType) };
};

export const addDocument = async (ownerType, id, body, file, { uploadedBy } = {}) => {
  const o = OWNERS[ownerType];
  const ownerId = parseId(id, o.label);
  const docType = String(body?.docType ?? "").trim().toUpperCase();
  if (!o.types[docType]) throw new AppError("Choose what kind of document this is", 400);
  const title = String(body?.title ?? "").replace(/\s+/g, " ").trim();
  if (title.length > 100) throw new AppError("The title can be at most 100 characters", 400);
  await loadOwner(ownerType, ownerId);
  const saved = await saveUpload(file, "document");
  try {
    const doc = await sequelize.transaction(async (t) => {
      await loadOwner(ownerType, ownerId, { transaction: t, lock: true }); // one upload at a time per record
      const count = await Document.count({ where: { ownerType, ownerId }, transaction: t });
      if (count >= MAX_DOCUMENTS_PER_OWNER) {
        throw new AppError(`This record already has ${MAX_DOCUMENTS_PER_OWNER} documents. Delete one first.`, 409);
      }
      return Document.create(
        {
          ownerType,
          ownerId,
          docType,
          title: title || o.types[docType],
          storageKey: saved.key,
          mime: saved.mime,
          sizeBytes: saved.size,
          originalName: saved.originalName,
          uploadedBy: uploadedBy ? String(uploadedBy).slice(0, 100) : null,
          createdAt: new Date(),
        },
        { transaction: t }
      );
    });
    const plain = typeof doc?.get === "function" ? doc.get({ plain: true }) : doc;
    return toPublicDoc(plain, o.types);
  } catch (e) {
    await storage.remove(saved.key);
    throw e;
  }
};

// One document of THIS owner (owner type + owner id + document id), or 404.
const findOwnedDocument = async (ownerType, id, docId, opts = {}) => {
  const ownerId = parseId(id, OWNERS[ownerType].label);
  const documentId = parseId(docId, "Document");
  const doc = await Document.findOne({ where: { documentId, ownerType, ownerId }, raw: true, ...opts });
  if (!doc) throw new AppError("Document not found", 404);
  return doc;
};

export const getDocumentFile = async (ownerType, id, docId) => {
  await loadOwner(ownerType, parseId(id, OWNERS[ownerType].label));
  const doc = await findOwnedDocument(ownerType, id, docId);
  return { key: doc.storageKey, mime: doc.mime, name: doc.originalName || doc.title };
};

export const removeDocument = async (ownerType, id, docId) => {
  const doc = await findOwnedDocument(ownerType, id, docId);
  await Document.destroy({ where: { documentId: doc.documentId, ownerType, ownerId: doc.ownerId } });
  await storage.remove(doc.storageKey);
  return { deleted: true, documentId: doc.documentId };
};
