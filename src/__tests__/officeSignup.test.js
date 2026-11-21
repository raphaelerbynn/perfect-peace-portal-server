// Security review: office logins are created by an Administrator only.
// Handlers stubbed: no database.
process.env.JWT_KEY = "test-secret";
process.env.NODE_ENV = "test";
import jwt from "jsonwebtoken";
import request from "supertest";

jest.mock("../controllers/authController.js", () => {
  const actual = jest.requireActual("../controllers/authController.js");
  const ok = (req, res) => res.json({ ok: true });
  return { __esModule: true, ...Object.fromEntries(Object.keys(actual).map((k) => [k, ok])) };
});

const app = require("../index.js").default;
const sign = (p) => jwt.sign(p, "test-secret", { algorithm: "HS256", expiresIn: "1h" });
const admin = sign({ category: "Administrator", username: "admin" });
const classTeacher = sign({ category: "Class Teacher", username: "ct", teacherId: 3 });
const pupil = sign({ id: 7, userRole: "STU" });
const body = { username: "x", password: "12345678", staffId: "3", category: "Accountant", email: "x@y.z" };

it.each([
  ["post", "/signup-management"],
  ["get", "/signup-staff-list"],
])("%s %s: no login 401, Class Teacher / pupil 403, Administrator ok", async (method, path) => {
  expect((await request(app)[method](path).send(body)).status).toBe(401);
  expect((await request(app)[method](path).set("Authorization", `Bearer ${classTeacher}`).send(body)).status).toBe(403);
  expect((await request(app)[method](path).set("Authorization", `Bearer ${pupil}`).send(body)).status).toBe(403);
  expect((await request(app)[method](path).set("Authorization", `Bearer ${admin}`).send(body)).status).toBe(200);
});
