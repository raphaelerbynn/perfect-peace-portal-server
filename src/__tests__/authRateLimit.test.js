// Go-live review: the sign-in limit is per account, so a school lab or a
// reverse proxy (one IP for everyone) isn't locked out after 20 sign-ins.
// The auth handlers are stubbed: no database.
process.env.JWT_KEY = "test-secret";
process.env.NODE_ENV = "test";
import request from "supertest";

jest.mock("../controllers/authController.js", () => {
  const actual = jest.requireActual("../controllers/authController.js");
  const stub = (req, res) => res.status(401).json({ message: "Incorrect credentials" });
  return { __esModule: true, ...Object.fromEntries(Object.keys(actual).map((k) => [k, stub])) };
});

const app = require("../index.js").default;

it("many different users from one IP are not blocked", async () => {
  const statuses = [];
  for (let i = 0; i < 25; i += 1) {
    statuses.push((await request(app).post("/signin").send({ indexNumber: `STU/${9000 + i}`, password: "x" })).status);
  }
  expect(statuses).toEqual(Array(25).fill(401));
});

it("one account trying over and over is limited", async () => {
  let last;
  for (let i = 0; i < 22; i += 1) last = await request(app).post("/signin").send({ indexNumber: "STU/1", password: "x" });
  expect(last.status).toBe(429);
  expect(last.body.message).toMatch(/Too many attempts for this account/);
});
