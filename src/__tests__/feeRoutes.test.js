// Deleting a payment: Finance roles only (Part A has no receipts or reversal).
process.env.JWT_KEY = "test-secret";
process.env.NODE_ENV = "test";

import jwt from "jsonwebtoken";
import request from "supertest";

jest.mock("../services/fee.js", () => {
  const actual = jest.requireActual("../services/fee.js");
  return { ...actual, removeFee: jest.fn(async () => 1) };
});

const app = require("../index.js").default;
const { removeFee } = require("../services/fee.js");

const sign = (p) => jwt.sign(p, "test-secret", { algorithm: "HS256", expiresIn: "1h" });
const admin = sign({ category: "Administrator", username: "head" });
const accountant = sign({ category: "Accountant", username: "bursar" });
const teacher = sign({ category: "Class Teacher", username: "staff/1" });
const student = sign({ id: 1, userRole: "STU" });

const del = (token) => request(app).delete("/delete-fee/7").set("Authorization", `Bearer ${token}`);

beforeEach(() => jest.clearAllMocks());

it.each([["Administrator", admin], ["Accountant", accountant]])("%s can delete a payment", async (_, token) => {
  const res = await del(token);
  expect(res.status).toBe(200);
  expect(removeFee).toHaveBeenCalledWith("7");
});

it.each([["a Class Teacher", teacher], ["a pupil", student]])("%s cannot (403)", async (_, token) => {
  const res = await del(token);
  expect(res.status).toBe(403);
  expect(removeFee).not.toHaveBeenCalled();
});

it("there is no reversal endpoint in Part A", async () => {
  const res = await request(app).post("/fees/7/reverse").set("Authorization", `Bearer ${admin}`).send({ reason: "Recorded twice" });
  expect(res.status).toBe(404);
});
