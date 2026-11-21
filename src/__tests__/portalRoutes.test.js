// Phase 0.4.2: portal (STU/STAFF) tokens must reach the read routes that share a
// path with management routes (/user-details, /news, /class, /subject). Before
// the fix, generalRouter's mount-level `authenticateManagementUser` returned 403
// for every portal token. Management tokens must still go through generalRouter
// and its role checks unchanged.
process.env.JWT_KEY = "test-secret";
process.env.NODE_ENV = "test";

import jwt from "jsonwebtoken";
import request from "supertest";

// Controllers are stubbed so no database is touched. Each stub reports who
// handled the request so we can tell the portal and management paths apart.

jest.mock("../controllers/generalController.js", () => {
  const actual = jest.requireActual("../controllers/generalController.js");
  const s = (name) => (req, res) => res.json({ handler: name, user: req.user });
  return {
    ...actual,
    fetchUserDetails: s("fetchUserDetails"),
    fetchNews: s("fetchNews"),
    fetchDashboardSummary: s("fetchDashboardSummary"),
  };
});
jest.mock("../controllers/onlyTeacherController.js", () => ({
  fetchClass: (req, res) => res.json({ handler: "fetchClass", user: req.user }),
}));
jest.mock("../controllers/subjectController.js", () => {
  const actual = jest.requireActual("../controllers/subjectController.js");
  return {
    ...actual,
    fetchSubject: (req, res) => res.json({ handler: "fetchSubject", user: req.user }),
  };
});

const app = require("../index.js").default;

const sign = (payload) =>
  jwt.sign(payload, "test-secret", { algorithm: "HS256", expiresIn: "1h" });

const student = sign({ id: 7, userRole: "STU" });
const teacher = sign({ id: 3, userRole: "STAFF" });
const admin = sign({ category: "Administrator", username: "admin", teacherId: null });
const accountant = sign({ category: "Accountant", username: "acc", teacherId: null });

const get = (path, token) => {
  const r = request(app).get(path);
  return token ? r.set("Authorization", `Bearer ${token}`) : r;
};

describe("portal routes with portal tokens", () => {
  it.each(["/user-details", "/news"])("STU token can GET %s", async (path) => {
    const res = await get(path, student);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: 7, userRole: "STU" });
  });

  it.each(["/user-details", "/news", "/class", "/subject"])(
    "STAFF token can GET %s",
    async (path) => {
      const res = await get(path, teacher);
      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({ id: 3, userRole: "STAFF" });
    }
  );

  it.each(["/class", "/subject"])("STU token is refused on %s (403)", async (path) => {
    const res = await get(path, student);
    expect(res.status).toBe(403);
  });

  it("portal token still cannot reach management-only routes", async () => {
    const res = await get("/dashboard-summary", student);
    expect(res.status).toBe(403);
  });

  it("a token with an unknown portal role is refused", async () => {
    const res = await get("/news", sign({ id: 1, userRole: "PARENT" }));
    expect(res.status).toBe(403);
  });
});

describe("shared paths with management tokens fall through to generalRouter", () => {
  it.each(["/news", "/class", "/subject"])("Administrator can GET %s", async (path) => {
    const res = await get(path, admin);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ category: "Administrator" });
  });

  it("generalRouter role checks still apply (Accountant cannot GET /subject)", async () => {
    const res = await get("/subject", accountant);
    expect(res.status).toBe(403);
  });

  it("management dashboard still works", async () => {
    const res = await get("/dashboard-summary", admin);
    expect(res.status).toBe(200);
    expect(res.body.handler).toBe("fetchDashboardSummary");
  });
});

describe("no token", () => {
  it.each(["/user-details", "/news", "/class", "/subject"])("GET %s is 401", async (path) => {
    const res = await get(path);
    expect(res.status).toBe(401);
  });
});

