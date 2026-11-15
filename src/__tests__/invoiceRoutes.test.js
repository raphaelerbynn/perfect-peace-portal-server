// B14: who may make invoices / credit notes, and the portal's own-invoices routes. Services stubbed.
process.env.JWT_KEY = "test-secret";
process.env.NODE_ENV = "test";

import jwt from "jsonwebtoken";
import request from "supertest";

jest.mock("../services/invoices.js", () => ({
  __esModule: true,
  listInvoices: jest.fn(async () => ({ invoices: [] })),
  invoicesForPrint: jest.fn(async () => ({ invoices: [] })),
  getInvoice: jest.fn(async (id) => ({ invoiceId: id })),
  generateInvoice: jest.fn(async (b, o) => ({ ...b, ...o })),
  bulkGenerate: jest.fn(async (b, o) => ({ ...b, ...o })),
  issueInvoice: jest.fn(async (id, b, o) => ({ id, ...o })),
  voidInvoice: jest.fn(async (id, b, o) => ({ id, ...o })),
  listCreditNotes: jest.fn(async () => ({ creditNotes: [] })),
  createCreditNote: jest.fn(async (b, o) => ({ ...b, ...o })),
  voidCreditNote: jest.fn(async (id, b, o) => ({ id, ...o })),
  portalInvoices: jest.fn(async (studentId) => [{ studentId }]),
  portalInvoice: jest.fn(async (studentId, id) => ({ studentId, id })),
}));

const app = require("../index.js").default;
const svc = require("../services/invoices.js");

const sign = (p) => jwt.sign(p, "test-secret", { algorithm: "HS256", expiresIn: "1h" });
const admin = sign({ category: "Administrator", username: "admin", teacherId: null });
const accountant = sign({ category: "Accountant", username: "bursar", teacherId: null });
const classTeacher = sign({ category: "Class Teacher", username: "ct", teacherId: 3 });
const pupil = sign({ id: 7, userRole: "STU" });
const teacher = sign({ id: 3, userRole: "STAFF" });
const auth = (r, t) => (t ? r.set("Authorization", `Bearer ${t}`) : r);

const FINANCE = [
  ["get", "/invoices"],
  ["get", "/invoices/print?termId=1&classId=1"],
  ["get", "/invoices/5"],
  ["post", "/invoices/generate"],
  ["post", "/invoices/bulk"],
  ["post", "/invoices/5/issue"],
  ["post", "/invoices/5/void"],
  ["get", "/credit-notes"],
];

it.each(FINANCE)("Administrator and Accountant may %s %s; Class Teacher and portal tokens may not", async (m, path) => {
  for (const t of [admin, accountant]) expect((await auth(request(app)[m](path), t).send({})).status).toBe(200);
  for (const t of [classTeacher, pupil, teacher]) expect((await auth(request(app)[m](path), t).send({})).status).toBe(403);
  expect((await request(app)[m](path).send({})).status).toBe(401);
});

it.each([
  ["post", "/credit-notes"],
  ["post", "/credit-notes/3/void"],
])("only an Administrator may %s %s (it changes what a pupil owes)", async (m, path) => {
  expect((await auth(request(app)[m](path), admin).send({})).status).toBe(200);
  for (const t of [accountant, classTeacher, pupil]) expect((await auth(request(app)[m](path), t).send({})).status).toBe(403);
});

it("who did it comes from the token, not the body", async () => {
  await auth(request(app).post("/invoices/generate"), accountant).send({ studentId: 1, termId: 2, by: "someone" });
  expect(svc.generateInvoice).toHaveBeenCalledWith({ studentId: 1, termId: 2, by: "someone" }, { by: "bursar" });
  await auth(request(app).post("/credit-notes"), admin).send({ invoiceId: 1, amount: 5, reason: "x", createdBy: "z" });
  expect(svc.createCreditNote).toHaveBeenCalledWith(expect.anything(), { by: "admin" });
});

it("the portal lists the signed-in pupil's own invoices (token id), pupils only", async () => {
  const res = await auth(request(app).get("/portal/invoices?studentId=99"), pupil);
  expect(res.status).toBe(200);
  expect(svc.portalInvoices).toHaveBeenCalledWith(7);
  const one = await auth(request(app).get("/portal/invoices/12"), pupil);
  expect(one.status).toBe(200);
  expect(svc.portalInvoice).toHaveBeenCalledWith(7, "12");
  for (const t of [teacher, admin, accountant]) expect((await auth(request(app).get("/portal/invoices"), t)).status).toBe(403);
  expect((await request(app).get("/portal/invoices")).status).toBe(401);
});
