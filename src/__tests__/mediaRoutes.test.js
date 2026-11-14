// B17: who may see / change pupil and staff photos and documents, through the
// real routes, storage on a temp folder, models stubbed (no DB).
process.env.JWT_KEY = "test-secret";
process.env.NODE_ENV = "test";

import fs from "fs";
import os from "os";
import path from "path";
import jwt from "jsonwebtoken";
import request from "supertest";
import { JPEG, PDF, PNG } from "./uploadFixtures.js";

const app = require("../index.js").default;
const sequelize = require("../config/database.js").default;
const { Class, Document, Student, Teacher } = require("../models/index.js");

const sign = (p) => jwt.sign(p, "test-secret", { algorithm: "HS256", expiresIn: "1h" });
const admin = sign({ category: "Administrator", username: "admin", teacherId: null });
const ct = sign({ category: "Class Teacher", username: "ct", teacherId: 3 }); // class "Basic 1"
const accountant = sign({ category: "Accountant", username: "acc", teacherId: null });
const pupilToken = sign({ id: 7, userRole: "STU" });
const teacherToken = sign({ id: "3", userRole: "STAFF" });
const auth = (r, t) => (t ? r.set("Authorization", `Bearer ${t}`) : r);

let dir;
let students; // id -> row
let staff;
let docs;
let nextDocId;

const storedFiles = () => {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(dir, p));
    }
  };
  walk(dir);
  return out;
};

const matches = (row, where) =>
  Object.entries(where).every(([k, v]) => {
    if (v && typeof v === "object") return row[k] !== true; // isDeleted: { [Op.not]: true }
    return row[k] === v;
  });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-media-"));
  process.env.UPLOAD_DIR = dir;
  students = {
    7: { studentId: 7, class: "Basic 1", classId: 1, photoKey: null, isDeleted: false },
    8: { studentId: 8, class: "Basic 2", classId: 2, photoKey: null, isDeleted: false },
    9: { studentId: 9, class: "Basic 1", classId: 1, photoKey: null, isDeleted: true },
  };
  staff = { 3: { teacherId: 3, photoKey: null, isDeleted: false }, 4: { teacherId: 4, photoKey: null, isDeleted: false } };
  docs = [];
  nextDocId = 1;

  jest.spyOn(sequelize, "transaction").mockImplementation(async (fn) => fn({ LOCK: { UPDATE: "UPDATE" } }));
  jest.spyOn(Class, "findOne").mockImplementation(async ({ where }) => (where.teacherId === 3 ? { classId: 1, name: "Basic 1" } : null));
  const findIn = (table, idField) => async ({ where }) => {
    const row = Object.values(table()).find((r) => r[idField] === where[idField] && matches(r, { isDeleted: where.isDeleted }));
    return row ? { ...row } : null;
  };
  jest.spyOn(Student, "findOne").mockImplementation(findIn(() => students, "studentId"));
  jest.spyOn(Teacher, "findOne").mockImplementation(findIn(() => staff, "teacherId"));
  jest.spyOn(Student, "update").mockImplementation(async (v, { where }) => {
    Object.assign(students[where.studentId], v);
    return [1];
  });
  jest.spyOn(Teacher, "update").mockImplementation(async (v, { where }) => {
    Object.assign(staff[where.teacherId], v);
    return [1];
  });
  jest.spyOn(Document, "count").mockImplementation(async ({ where }) => docs.filter((d) => matches(d, where)).length);
  jest.spyOn(Document, "create").mockImplementation(async (v) => {
    const d = { documentId: nextDocId++, ...v };
    docs.push(d);
    return { get: () => ({ ...d }) };
  });
  jest.spyOn(Document, "findAll").mockImplementation(async ({ where, attributes }) =>
    docs.filter((d) => matches(d, where)).map((d) => Object.fromEntries(attributes.map((a) => [a, d[a]])))
  );
  jest.spyOn(Document, "findOne").mockImplementation(async ({ where }) => {
    const d = docs.find((x) => matches(x, where));
    return d ? { ...d } : null;
  });
  jest.spyOn(Document, "destroy").mockImplementation(async ({ where }) => {
    const before = docs.length;
    docs = docs.filter((x) => !matches(x, where));
    return before - docs.length;
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.UPLOAD_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

const upload = (url, token, buf, name = "a.jpg", fields = {}) => {
  let r = auth(request(app).post(url), token);
  for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
  return buf ? r.attach("file", buf, name) : r;
};

describe("pupil photo", () => {
  it("Administrator uploads, reads back, replaces (old file removed) and deletes", async () => {
    const up = await upload("/students/7/photo", admin, JPEG);
    expect(up.status).toBe(200);
    expect(up.body).toEqual({ hasPhoto: true, mime: "image/jpeg", size: JPEG.length });
    expect(JSON.stringify(up.body)).not.toMatch(/photos\//); // key never sent
    const first = students[7].photoKey;
    expect(storedFiles()).toEqual([first]);

    const get = await auth(request(app).get("/students/7/photo"), admin).buffer(true).parse((res, cb) => {
      const c = [];
      res.on("data", (d) => c.push(d));
      res.on("end", () => cb(null, Buffer.concat(c)));
    });
    expect(get.status).toBe(200);
    expect(get.headers["content-type"]).toBe("image/jpeg");
    expect(get.headers["cache-control"]).toBe("private, no-store");
    expect(get.headers["x-content-type-options"]).toBe("nosniff");
    expect(get.body.equals(JPEG)).toBe(true);

    expect((await upload("/students/7/photo", admin, PNG, "b.png")).status).toBe(200);
    expect(storedFiles()).toEqual([students[7].photoKey]);
    expect(students[7].photoKey).not.toBe(first);

    expect((await auth(request(app).delete("/students/7/photo"), admin)).status).toBe(200);
    expect(storedFiles()).toEqual([]);
    expect((await auth(request(app).get("/students/7/photo"), admin)).status).toBe(404);
  });

  it("refuses fake images, PDFs and oversize files, and keeps nothing", async () => {
    expect((await upload("/students/7/photo", admin, Buffer.from("<html><script>x</script></html>"), "x.jpg")).status).toBe(415);
    expect((await upload("/students/7/photo", admin, PDF, "x.jpg")).status).toBe(415);
    const big = Buffer.alloc(5 * 1024 * 1024 + 1, 0);
    JPEG.copy(big);
    expect((await upload("/students/7/photo", admin, big)).status).toBe(413);
    expect((await upload("/students/7/photo", admin, null)).status).toBe(400);
    expect(storedFiles()).toEqual([]);
    expect(students[7].photoKey).toBeNull();
  });

  it("Class Teacher: own class yes, another class 403 (before the upload is read)", async () => {
    expect((await upload("/students/7/photo", ct, JPEG)).status).toBe(200);
    const other = await upload("/students/8/photo", ct, JPEG);
    expect(other.status).toBe(403);
    expect((await auth(request(app).get("/students/8/photo"), ct)).status).toBe(403);
    expect(storedFiles()).toHaveLength(1);
  });

  it("Accountant and portal tokens are refused; no token is 401", async () => {
    expect((await upload("/students/7/photo", accountant, JPEG)).status).toBe(403);
    expect((await auth(request(app).get("/students/7/photo"), accountant)).status).toBe(403);
    expect((await auth(request(app).get("/students/7/photo"), pupilToken)).status).toBe(403);
    expect((await auth(request(app).get("/students/7/photo"), teacherToken)).status).toBe(403);
    expect((await request(app).get("/students/7/photo")).status).toBe(401);
    expect(storedFiles()).toEqual([]);
  });

  it("archived or unknown pupils and junk ids are 404", async () => {
    expect((await upload("/students/9/photo", admin, JPEG)).status).toBe(404);
    expect((await upload("/students/99/photo", admin, JPEG)).status).toBe(404);
    expect((await auth(request(app).get("/students/..%2F..%2Fetc/photo"), admin)).status).toBe(404);
    expect((await auth(request(app).get("/students/7abc/photo"), admin)).status).toBe(404);
    expect(storedFiles()).toEqual([]);
  });
});

describe("pupil documents", () => {
  it("upload, list (no storage key), download, delete", async () => {
    const up = await upload("/students/7/documents", admin, PDF, "../../birth cert.pdf", { docType: "BIRTH_CERTIFICATE" });
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({ documentId: 1, docType: "BIRTH_CERTIFICATE", title: "Birth certificate", mime: "application/pdf", originalName: "birth cert.pdf", uploadedBy: "admin" });
    expect(up.body.storageKey).toBeUndefined();

    const list = await auth(request(app).get("/students/7/documents"), admin);
    expect(list.status).toBe(200);
    expect(list.body.documents).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toMatch(/documents\/\d{4}\//);
    expect(list.body.docTypes.map((t) => t.value)).toContain("BIRTH_CERTIFICATE");

    const file = await auth(request(app).get("/students/7/documents/1/file"), admin);
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toBe("application/pdf");
    expect(file.headers["content-disposition"]).toContain('filename="birth cert.pdf"');
    expect(file.headers["content-security-policy"]).toContain("sandbox");

    expect((await auth(request(app).delete("/students/7/documents/1"), admin)).status).toBe(200);
    expect(docs).toEqual([]);
    expect(storedFiles()).toEqual([]);
  });

  it("a document id from another pupil is 404 (no IDOR), even for the Administrator", async () => {
    await upload("/students/8/documents", admin, PDF, "x.pdf", { docType: "OTHER" });
    expect((await auth(request(app).get("/students/7/documents/1/file"), admin)).status).toBe(404);
    expect((await auth(request(app).delete("/students/7/documents/1"), admin)).status).toBe(404);
    expect((await auth(request(app).get("/staff/3/documents/1/file"), admin)).status).toBe(404); // same id, other owner type
    expect(docs).toHaveLength(1);
  });

  it("Class Teacher sees and files documents for own class only", async () => {
    await upload("/students/8/documents", admin, PDF, "x.pdf", { docType: "OTHER" });
    expect((await auth(request(app).get("/students/8/documents"), ct)).status).toBe(403);
    expect((await auth(request(app).get("/students/8/documents/1/file"), ct)).status).toBe(403);
    expect((await auth(request(app).delete("/students/8/documents/1"), ct)).status).toBe(403);
    expect((await upload("/students/8/documents", ct, PDF, "y.pdf", { docType: "OTHER" })).status).toBe(403);
    expect((await upload("/students/7/documents", ct, PDF, "y.pdf", { docType: "OTHER" })).status).toBe(200);
    expect((await auth(request(app).get("/students/7/documents"), ct)).body.documents).toHaveLength(1);
  });

  it("needs a known document type; refuses HTML / zip; keeps no file on failure", async () => {
    expect((await upload("/students/7/documents", admin, PDF, "x.pdf", { docType: "PASSPORT" })).status).toBe(400);
    expect((await upload("/students/7/documents", admin, Buffer.from("<html>hello world</html>"), "x.pdf", { docType: "OTHER" })).status).toBe(415);
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40)]);
    expect((await upload("/students/7/documents", admin, zip, "x.docx", { docType: "OTHER" })).status).toBe(415);
    expect(storedFiles()).toEqual([]);
  });

  it("a database failure after saving removes the new file", async () => {
    Document.create.mockRejectedValueOnce(new Error("db down"));
    expect((await upload("/students/7/documents", admin, PDF, "x.pdf", { docType: "OTHER" })).status).toBe(500);
    expect(storedFiles()).toEqual([]);
  });
});

describe("staff photo and documents: Administrator only", () => {
  it("Administrator can; Class Teacher (even for their own record), Accountant and portal can't", async () => {
    expect((await upload("/staff/3/documents", admin, PDF, "c.pdf", { docType: "CONTRACT" })).status).toBe(200);
    expect((await upload("/staff/3/photo", admin, JPEG)).status).toBe(200);
    for (const t of [ct, accountant, teacherToken, pupilToken]) {
      expect((await auth(request(app).get("/staff/3/documents"), t)).status).toBe(403);
      expect((await auth(request(app).get("/staff/3/documents/1/file"), t)).status).toBe(403);
      expect((await auth(request(app).get("/staff/3/photo"), t)).status).toBe(403);
      expect((await upload("/staff/3/documents", t, PDF, "c.pdf", { docType: "CONTRACT" })).status).toBe(403);
    }
    expect(docs).toHaveLength(1);
    expect((await upload("/staff/3/documents", admin, PDF, "c.pdf", { docType: "BIRTH_CERTIFICATE" })).status).toBe(400); // pupil type
  });
});

describe("portal /portal/photo (own photo only)", () => {
  it("a pupil gets their own; a teacher gets their own", async () => {
    await upload("/students/7/photo", admin, JPEG);
    await upload("/staff/3/photo", admin, PNG, "t.png");
    const p = await auth(request(app).get("/portal/photo"), pupilToken);
    expect(p.status).toBe(200);
    expect(p.headers["content-type"]).toBe("image/jpeg");
    const t = await auth(request(app).get("/portal/photo"), teacherToken);
    expect(t.status).toBe(200);
    expect(t.headers["content-type"]).toBe("image/png");
  });
  it("no photo = 404; no token = 401; an office token is not served here", async () => {
    expect((await auth(request(app).get("/portal/photo"), pupilToken)).status).toBe(404);
    expect((await request(app).get("/portal/photo")).status).toBe(401);
    expect((await auth(request(app).get("/portal/photo"), admin)).status).toBe(404);
  });
});
