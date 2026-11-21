// Security review: pupil-only routes + the fees lockout enforced by the API.
process.env.JWT_KEY = "test-secret";
process.env.NODE_ENV = "test";
import jwt from "jsonwebtoken";
import request from "supertest";

jest.mock("../controllers/onlyStudentsController.js", () => {
  const ok = (name) => (req, res) => res.json({ handler: name, id: req.user.id });
  return {
    __esModule: true,
    fetchResults: ok("results"),
    fetchResultDetails: ok("details"),
    fetchNurseryResults: ok("nursery"),
    fetchFeeCheck: ok("feecheck"),
    fetchLastPaid: ok("lastpaid"),
  };
});
jest.mock("../models/index.js", () => {
  const actual = jest.requireActual("../models/index.js");
  return { __esModule: true, ...actual, FeeCheck: { findAll: jest.fn() }, Student: { ...actual.Student, findOne: jest.fn() } };
});

const app = require("../index.js").default;
const { FeeCheck, Student } = require("../models/index.js");
const sign = (p) => jwt.sign(p, "test-secret", { algorithm: "HS256", expiresIn: "1h" });
const pupil = sign({ id: 7, userRole: "STU" });
const teacher = sign({ id: 7, userRole: "STAFF" });
const auth = (r, t) => r.set("Authorization", `Bearer ${t}`);

beforeEach(() => {
  FeeCheck.findAll.mockResolvedValue([{ value: "true" }]);
  Student.findOne.mockResolvedValue({ feesOwing: 50 });
});

it("a teacher's portal token can't read the pupil with the same id", async () => {
  for (const path of ["/result", "/result-details", "/nursery-result", "/last-fee-paid", "/feecheck"]) {
    expect((await auth(request(app).get(path), teacher)).status).toBe(403);
  }
});
it("a pupil reads their own results", async () => {
  const res = await auth(request(app).get("/result"), pupil);
  expect(res.body).toEqual({ handler: "results", id: 7 });
});
it("results are refused while fees above the limit are owing (and the check is on)", async () => {
  Student.findOne.mockResolvedValue({ feesOwing: "150" });
  const res = await auth(request(app).get("/result-details"), pupil);
  expect(res.status).toBe(403);
  expect(res.body.code).toBe("FEES_OWING");
  expect((await auth(request(app).get("/last-fee-paid"), pupil)).status).toBe(200); // fees info stays visible
  FeeCheck.findAll.mockResolvedValue([{ value: "false" }]);
  expect((await auth(request(app).get("/result"), pupil)).status).toBe(200);
});
