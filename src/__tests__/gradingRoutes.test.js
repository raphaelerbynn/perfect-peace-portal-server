// B8: who may read and change grading scales. Service stubbed, no DB.
process.env.JWT_KEY = "test-secret";
process.env.NODE_ENV = "test";

import jwt from "jsonwebtoken";
import request from "supertest";

jest.mock("../services/grading.js", () => ({
  __esModule: true,
  ...jest.requireActual("../services/grading.js"),
  listScales: jest.fn(async () => []),
  bandsForClass: jest.fn(async (name) => ({ name: "Built-in", bands: [], className: name })),
  createScale: jest.fn(async (b) => b),
  updateScale: jest.fn(async (id, b) => ({ id, ...b })),
  deleteScale: jest.fn(async (id) => ({ deleted: id })),
}));

const app = require("../index.js").default;
const svc = require("../services/grading.js");

const sign = (p) => jwt.sign(p, "test-secret", { algorithm: "HS256", expiresIn: "1h" });
const teacher = sign({ id: "3", userRole: "STAFF" });
const admin = sign({ category: "Administrator", username: "admin", teacherId: null });
const classTeacher = sign({ category: "Class Teacher", username: "ct", teacherId: 3 });
const accountant = sign({ category: "Accountant", username: "acc", teacherId: null });
const auth = (r, t) => (t ? r.set("Authorization", `Bearer ${t}`) : r);

it.each([["Administrator", admin], ["Class Teacher", classTeacher]])("%s can read the scales and a class's bands", async (_l, token) => {
  expect((await auth(request(app).get("/grading-scales"), token)).status).toBe(200);
  const res = await auth(request(app).get("/grading-scales/for-class?class=JHS%201"), token);
  expect(res.status).toBe(200);
  expect(svc.bandsForClass).toHaveBeenCalledWith("JHS 1");
});

it("Accountants and portal tokens can't read them", async () => {
  expect((await auth(request(app).get("/grading-scales"), accountant)).status).toBe(403);
  expect((await auth(request(app).get("/grading-scales"), teacher)).status).toBe(403);
  expect((await request(app).get("/grading-scales")).status).toBe(401);
});

it("only the Administrator changes them", async () => {
  expect((await auth(request(app).post("/grading-scales"), admin).send({ name: "X" })).status).toBe(200);
  expect((await auth(request(app).put("/grading-scales/2"), admin).send({ name: "Y" })).status).toBe(200);
  expect(svc.updateScale).toHaveBeenCalledWith("2", { name: "Y" });
  expect((await auth(request(app).delete("/grading-scales/2"), admin)).status).toBe(200);
  for (const token of [classTeacher, accountant, teacher]) {
    expect((await auth(request(app).post("/grading-scales"), token).send({})).status).toBe(403);
    expect((await auth(request(app).put("/grading-scales/2"), token).send({})).status).toBe(403);
    expect((await auth(request(app).delete("/grading-scales/2"), token)).status).toBe(403);
  }
  expect(svc.createScale).toHaveBeenCalledTimes(1);
});
