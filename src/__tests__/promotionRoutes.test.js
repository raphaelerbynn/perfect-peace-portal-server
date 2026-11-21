// B5: promotion routes are Administrator only (history is readable by Class
// Teachers too). Services stubbed, no DB.
process.env.JWT_KEY = "test-secret";
process.env.NODE_ENV = "test";

import jwt from "jsonwebtoken";
import request from "supertest";

jest.mock("../services/promotion.js", () => ({
  __esModule: true,
  getRules: jest.fn(async () => ({})),
  saveRules: jest.fn(async (b, o) => ({ b, o })),
  getLadder: jest.fn(async () => []),
  saveLadder: jest.fn(async () => ({ saved: 0 })),
  getPreview: jest.fn(async (q) => ({ q })),
  acceptPromotion: jest.fn(async (b, o) => ({ b, o })),
  getStatus: jest.fn(async () => ({ pendingClasses: 0 })),
  getHistory: jest.fn(async (id) => [{ id }]),
}));

const app = require("../index.js").default;
const svc = require("../services/promotion.js");
const sign = (p) => jwt.sign(p, "test-secret", { algorithm: "HS256", expiresIn: "1h" });
const admin = sign({ category: "Administrator", username: "admin" });
const classTeacher = sign({ category: "Class Teacher", username: "ct", teacherId: 3 });
const accountant = sign({ category: "Accountant", username: "acc" });
const auth = (r, t) => r.set("Authorization", `Bearer ${t}`);

it("Administrator previews and accepts; the server records who decided", async () => {
  expect((await auth(request(app).get("/promotion/preview?classId=1&termId=3"), admin)).body).toEqual({ q: { classId: "1", termId: "3" } });
  const res = await auth(request(app).post("/promotion/accept"), admin).send({ classId: 1, termId: 3, decisions: [] });
  expect(res.status).toBe(200);
  expect(svc.acceptPromotion).toHaveBeenCalledWith({ classId: 1, termId: 3, decisions: [] }, { decidedBy: "admin" });
  expect((await auth(request(app).put("/promotion/rules"), admin).send({ defaultPassMark: 50 })).status).toBe(200);
  expect(svc.saveRules).toHaveBeenCalledWith({ defaultPassMark: 50 }, { updatedBy: "admin" });
  expect((await auth(request(app).put("/promotion/class-order"), admin).send({ classes: [] })).status).toBe(200);
});

it.each([
  ["get", "/promotion/preview?classId=1&termId=3"],
  ["post", "/promotion/accept"],
  ["put", "/promotion/rules"],
  ["put", "/promotion/class-order"],
  ["get", "/promotion/status?termId=3"],
])("Class Teacher and Accountant can't %s %s", async (method, path) => {
  for (const t of [classTeacher, accountant]) expect((await auth(request(app)[method](path), t).send({})).status).toBe(403);
});

it("history: Administrator and Class Teacher, not Accountant", async () => {
  expect((await auth(request(app).get("/promotion/history/5"), admin)).body).toEqual([{ id: "5" }]);
  expect((await auth(request(app).get("/promotion/history/5"), classTeacher)).status).toBe(200);
  expect((await auth(request(app).get("/promotion/history/5"), accountant)).status).toBe(403);
});
