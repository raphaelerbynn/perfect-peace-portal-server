// B12: who may manage discounts, bill a term and read statements. Services stubbed.
process.env.JWT_KEY = "test-secret";
process.env.NODE_ENV = "test";

import jwt from "jsonwebtoken";
import request from "supertest";

jest.mock("../services/discounts.js", () => ({
  __esModule: true,
  listDiscountTypes: jest.fn(async () => []),
  createDiscountType: jest.fn(async (b, o) => ({ ...b, ...o })),
  updateDiscountType: jest.fn(async () => ({})),
  deleteDiscountType: jest.fn(async () => ({ deleted: true })),
  listStudentDiscounts: jest.fn(async () => []),
  addStudentDiscount: jest.fn(async (b, o) => ({ ...b, ...o })),
  endStudentDiscount: jest.fn(async () => ({})),
  removeStudentDiscount: jest.fn(async () => ({ deleted: true })),
  siblingSuggestions: jest.fn(async () => []),
}));
jest.mock("../services/termBilling.js", () => ({
  __esModule: true,
  previewTermBilling: jest.fn(async () => ({ classes: [] })),
  billClassForTerm: jest.fn(async (b, o) => ({ ...b, ...o })),
}));
jest.mock("../services/feeStatement.js", () => ({ __esModule: true, getStatement: jest.fn(async () => ({ periods: [] })) }));

const app = require("../index.js").default;
const billing = require("../services/termBilling.js");
const discounts = require("../services/discounts.js");

const sign = (p) => jwt.sign(p, "test-secret", { algorithm: "HS256", expiresIn: "1h" });
const admin = sign({ category: "Administrator", username: "admin", teacherId: null });
const classTeacher = sign({ category: "Class Teacher", username: "ct", teacherId: 3 });
const accountant = sign({ category: "Accountant", username: "bursar", teacherId: null });
const parentPortal = sign({ id: 7, userRole: "STU" });
const auth = (r, t) => (t ? r.set("Authorization", `Bearer ${t}`) : r);

const FINANCE_ROUTES = [
  ["get", "/discount-types"],
  ["get", "/student-discounts?studentId=1"],
  ["get", "/student-discounts/sibling-suggestions"],
  ["post", "/student-discounts"],
  ["patch", "/student-discounts/1"],
  ["delete", "/student-discounts/1"],
  ["get", "/term-billing/3/preview"],
  ["post", "/term-billing/3/bill"],
  ["get", "/fee-statement/1"],
];

it.each(FINANCE_ROUTES)("Administrator and Accountant may %s %s; Class Teacher and portal tokens may not", async (m, path) => {
  for (const t of [admin, accountant]) expect((await auth(request(app)[m](path), t).send({})).status).toBe(200);
  expect((await auth(request(app)[m](path), classTeacher).send({})).status).toBe(403);
  expect((await auth(request(app)[m](path), parentPortal).send({})).status).toBe(403);
});

it.each([
  ["post", "/discount-types"],
  ["patch", "/discount-types/1"],
  ["delete", "/discount-types/1"],
])("only an Administrator may %s %s (what discounts exist)", async (m, path) => {
  expect((await auth(request(app)[m](path), admin).send({})).status).toBe(200);
  expect((await auth(request(app)[m](path), accountant).send({})).status).toBe(403);
});

it("records who billed / who gave the discount (from the token, not the body)", async () => {
  await auth(request(app).post("/term-billing/3/bill"), accountant).send({ classId: 1, expectedCount: 2, expectedTotal: 10, billedBy: "someone" });
  expect(billing.billClassForTerm).toHaveBeenCalledWith({ classId: 1, expectedCount: 2, expectedTotal: 10, billedBy: "someone", termId: "3" }, { billedBy: "bursar" });
  await auth(request(app).post("/student-discounts"), accountant).send({ studentId: 1, discountTypeId: 2 });
  expect(discounts.addStudentDiscount).toHaveBeenCalledWith({ studentId: 1, discountTypeId: 2 }, { createdBy: "bursar" });
});
