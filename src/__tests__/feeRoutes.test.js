// B13: who may reverse a payment, and hard delete is gone.
process.env.JWT_KEY = "test-secret";
process.env.NODE_ENV = "test";

import jwt from "jsonwebtoken";
import request from "supertest";

jest.mock("../services/fee.js", () => {
  const actual = jest.requireActual("../services/fee.js");
  return {
    ...actual,
    reverseFee: jest.fn(async (id, opts) => ({ feeId: Number(id), studentId: 1, paid: "200", receiptNo: "PPS-2026-000001", owing: 900, reversedBy: opts.reversedBy })),
  };
});
jest.mock("../services/test.js", () => {
  const actual = jest.requireActual("../services/test.js");
  return { ...actual, getParentContact: jest.fn(async () => ["0245556666"]) };
});
jest.mock("../services/messaging.js", () => {
  const actual = jest.requireActual("../services/messaging.js");
  return { ...actual, sendSMSMessage: jest.fn(async () => ({})) };
});

const app = require("../index.js").default;
const { reverseFee } = require("../services/fee.js");
const { sendSMSMessage } = require("../services/messaging.js");

const sign = (p) => jwt.sign(p, "test-secret", { algorithm: "HS256", expiresIn: "1h" });
const admin = sign({ category: "Administrator", username: "head" });
const accountant = sign({ category: "Accountant", username: "bursar" });
const teacher = sign({ category: "Class Teacher", username: "staff/1" });
const student = sign({ id: 1, userRole: "STU" });

const reverse = (token, body = { reason: "Recorded twice" }) =>
  request(app).post("/fees/7/reverse").set("Authorization", `Bearer ${token}`).send(body);

beforeEach(() => jest.clearAllMocks());

describe("POST /fees/:id/reverse", () => {
  it("Administrator can reverse; the username is recorded", async () => {
    const res = await reverse(admin);
    expect(res.status).toBe(200);
    expect(reverseFee).toHaveBeenCalledWith("7", { reason: "Recorded twice", reversedBy: "head" });
    expect(sendSMSMessage).not.toHaveBeenCalled(); // only when asked
  });

  it.each([["Accountant", accountant], ["Class Teacher", teacher], ["student", student]])(
    "%s cannot reverse (403)",
    async (_who, token) => {
      const res = await reverse(token);
      expect(res.status).toBe(403);
      expect(reverseFee).not.toHaveBeenCalled();
    }
  );

  it("sends the parent an SMS only when notifyParent is true", async () => {
    const res = await reverse(admin, { reason: "Recorded twice", notifyParent: true });
    expect(res.status).toBe(200);
    expect(res.body.parentNotified).toBe(true);
    expect(sendSMSMessage).toHaveBeenCalledWith(expect.stringContaining("PPS-2026-000001"), ["0245556666"]);
  });

  it("a failed SMS does not fail the reversal", async () => {
    sendSMSMessage.mockRejectedValueOnce(new Error("Arkesel down"));
    const res = await reverse(admin, { reason: "Recorded twice", notifyParent: true });
    expect(res.status).toBe(200);
    expect(res.body.parentNotified).toBe(false);
  });
});

describe("DELETE /delete-fee/:id", () => {
  it("is gone (410) and points to reversal", async () => {
    const res = await request(app).delete("/delete-fee/7").set("Authorization", `Bearer ${accountant}`);
    expect(res.status).toBe(410);
    expect(res.body.message).toMatch(/reverse/i);
  });
});
