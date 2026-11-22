// B18: school branding routes. Real routes and storage (temp folder), the
// settings model stubbed (no DB).
process.env.JWT_KEY = "test-secret";
process.env.NODE_ENV = "test";

import fs from "fs";
import os from "os";
import path from "path";
import jwt from "jsonwebtoken";
import request from "supertest";
import { JPEG, PDF, PNG } from "./uploadFixtures.js";

const app = require("../index.js").default;
const sequelize = require("../config/database.js").default;
const { SchoolSettings } = require("../models/index.js");
const school = require("../services/school.js");

const sign = (p) => jwt.sign(p, "test-secret", { algorithm: "HS256", expiresIn: "1h" });
const admin = sign({ category: "Administrator", username: "admin", teacherId: null });
const ct = sign({ category: "Class Teacher", username: "ct", teacherId: 3 });
const accountant = sign({ category: "Accountant", username: "acc", teacherId: null });
const pupil = sign({ id: 7, userRole: "STU" });
const auth = (r, t) => (t ? r.set("Authorization", `Bearer ${t}`) : r);

let dir;
let row; // the School_settings row, or null
const files = () => {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(dir, p));
    }
  };
  walk(dir);
  return out;
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-school-"));
  process.env.UPLOAD_DIR = dir;
  school.clearSchoolCache();
  row = {
    schoolSettingsId: 1,
    name: "PERFECT PEACE PREPARATORY SCHOOL",
    shortName: "Perfect Peace",
    motto: null,
    addressLines: "P.O. BOX 13\nMEMPEASEM/ESSAMAN",
    email: "perfectpeacepreparatoryschool@gmail.com",
    phones: "024 233 2420/024 315 4072",
    logoKey: null,
    primaryColor: null,
    accentColor: null,
    admissionFormat: "PPS/{YYYY}/{0000}",
    reportCardFooter: null,
    receiptFooter: null,
  };
  jest.spyOn(sequelize, "transaction").mockImplementation(async (fn) => fn({ LOCK: { UPDATE: "UPDATE" } }));
  jest.spyOn(sequelize, "query").mockResolvedValue([]); // admission counter / pupils: none yet
  jest.spyOn(SchoolSettings, "findOne").mockImplementation(async ({ raw }) => (row ? (raw ? { ...row } : { get: () => ({ ...row }) }) : null));
  jest.spyOn(SchoolSettings, "update").mockImplementation(async (v) => {
    Object.assign(row, v);
    return [1];
  });
  jest.spyOn(SchoolSettings, "create").mockImplementation(async (v) => {
    row = { ...v };
    return row;
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.UPLOAD_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("GET /school (public)", () => {
  it("today's school details with no token, display fields only", async () => {
    const res = await request(app).get("/school");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      name: "PERFECT PEACE PREPARATORY SCHOOL",
      shortName: "Perfect Peace",
      motto: null,
      addressLines: ["P.O. BOX 13", "MEMPEASEM/ESSAMAN"],
      email: "perfectpeacepreparatoryschool@gmail.com",
      phones: "024 233 2420/024 315 4072",
      primaryColor: null,
      accentColor: null,
      reportCardFooter: null,
      receiptFooter: null,
      logoUrl: null,
    });
    expect(res.body.admissionFormat).toBeUndefined();
  });

  it("before migration 034 is applied: the same defaults, not a 500", async () => {
    SchoolSettings.findOne.mockRejectedValueOnce(Object.assign(new Error("relation does not exist"), { original: { code: "42P01" } }));
    const res = await request(app).get("/school");
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("PERFECT PEACE PREPARATORY SCHOOL");
  });

  it("no logo uploaded = 404 (apps use the built-in crest)", async () => {
    expect((await request(app).get("/school/logo")).status).toBe(404);
  });
});

describe("Administrator only: settings, logo, admission format", () => {
  it.each([
    ["get", "/school/settings"],
    ["put", "/school"],
    ["post", "/school/logo"],
    ["delete", "/school/logo"],
    ["get", "/school/admission-preview?format=A-{0}"],
    ["get", "/students/next-admission-no"],
  ])("%s %s: Class Teacher / Accountant 403, portal 403, no token 401", async (method, url) => {
    for (const t of [ct, accountant, pupil]) expect((await auth(request(app)[method](url), t)).status).toBe(403);
    expect((await request(app)[method](url)).status).toBe(401);
  });

  it("saves a partial update: colours normalised, address lines, cache cleared", async () => {
    await request(app).get("/school"); // warm the cache
    const res = await auth(request(app).put("/school"), admin).send({
      primaryColor: "#1E6B3A",
      accentColor: "#abc",
      addressLines: "P.O. BOX 13\n\n MEMPEASEM/ESSAMAN \nCentral Region",
      motto: "  Knowledge and peace ",
    });
    expect(res.status).toBe(200);
    expect(row).toMatchObject({ primaryColor: "#1e6b3a", accentColor: "#aabbcc", motto: "Knowledge and peace", updatedBy: "admin", name: "PERFECT PEACE PREPARATORY SCHOOL" });
    expect(row.addressLines).toBe("P.O. BOX 13\nMEMPEASEM/ESSAMAN\nCentral Region");
    expect(res.body.nextAdmissionNo).toMatch(/^PPS\/\d{4}\/0001$/);
    expect((await request(app).get("/school")).body.primaryColor).toBe("#1e6b3a");
  });

  it("blank colour = back to the built-in theme", async () => {
    row.primaryColor = "#123456";
    await auth(request(app).put("/school"), admin).send({ primaryColor: "" });
    expect(row.primaryColor).toBeNull();
  });

  it.each([
    [{ primaryColor: "green" }, /colour like/],
    [{ accentColor: "#abcd" }, /colour like/],
    [{ primaryColor: "#ggg000" }, /colour like/],
    [{ name: "" }, /School name is required/],
    [{ name: "A".repeat(101) }, /at most 100/],
    [{ email: "not-an-email" }, /Email is invalid/],
    [{ addressLines: ["a", "b", "c", "d", "e"] }, /at most 4 lines/],
    [{ admissionFormat: "PPS-" }, /running number/],
    [{}, /Nothing to save/],
  ])("refuses %j with a 400", async (body, msg) => {
    const res = await auth(request(app).put("/school"), admin).send(body);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(msg);
  });

  it("logo: PNG accepted and served publicly (cross-origin <img>), replaced, then removed", async () => {
    const up = await auth(request(app).post("/school/logo"), admin).attach("file", PNG, "logo.png");
    expect(up.status).toBe(200);
    expect(up.body.logoUrl).toMatch(/^\/school\/logo\?v=[a-f0-9]{12}$/);
    expect(JSON.stringify(up.body)).not.toMatch(/branding\//);
    const first = row.logoKey;
    const get = await request(app).get(up.body.logoUrl);
    expect(get.status).toBe(200);
    expect(get.headers["content-type"]).toBe("image/png");
    expect(get.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(get.headers["cache-control"]).toBe("public, max-age=3600");

    const again = await auth(request(app).post("/school/logo"), admin).attach("file", JPEG, "logo.jpg");
    expect(again.body.logoUrl).not.toBe(up.body.logoUrl);
    expect(files()).toEqual([row.logoKey]);
    expect(row.logoKey).not.toBe(first);

    expect((await auth(request(app).delete("/school/logo"), admin)).body.logoUrl).toBeNull();
    expect(files()).toEqual([]);
  });

  it("logo: SVG, PDF, HTML and oversize files are refused", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect((await auth(request(app).post("/school/logo"), admin).attach("file", svg, "logo.svg")).status).toBe(415);
    expect((await auth(request(app).post("/school/logo"), admin).attach("file", PDF, "logo.png")).status).toBe(415);
    const big = Buffer.alloc(2 * 1024 * 1024 + 1);
    PNG.copy(big);
    expect((await auth(request(app).post("/school/logo"), admin).attach("file", big, "logo.png")).status).toBe(413);
    expect(files()).toEqual([]);
    expect(row.logoKey).toBeNull();
  });

  it("admission preview and the form's next-number suggestion", async () => {
    const p = await auth(request(app).get("/school/admission-preview").query({ format: "ACM-{000}" }), admin);
    expect(p.status).toBe(200);
    expect(p.body).toEqual({ format: "ACM-{000}", example: "ACM-001", next: "ACM-001" });
    expect((await auth(request(app).get("/school/admission-preview").query({ format: "ACM-{MM}" }), admin)).status).toBe(400);
    const n = await auth(request(app).get("/students/next-admission-no"), admin);
    expect(n.body).toEqual({ admissionNo: expect.stringMatching(/^PPS\/\d{4}\/0001$/), format: "PPS/{YYYY}/{0000}" });
  });
});
