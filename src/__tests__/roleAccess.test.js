// B10: who gets past the permission gates of EVERY route, found by walking the
// Express router stack (src/testSupport/routeAccess.js). No database.
//
// BEFORE is what the three original roles reached before B10 (snapshot taken
// from feature/part-b on 2026-11-17, before any role work), plus the B10
// review fixes (PUT /promotion/class-order Administrator only), the new
// B10 routes and the AI routes as the AI branch had them before B10
// (feature/ai-work 6e1cee7: authorizeRoles / the AI role table). The system roles' permission sets (utils/permissions.js) must
// reproduce it route by route. A new route fails here until it is added on
// purpose.
//   A = Administrator, CT = Class Teacher, Acc = Accountant,
//   "*" = no permission gate (public, portal-only, or the caller's own
//   access), "" = nobody.
process.env.JWT_KEY = "test-secret";
process.env.NODE_ENV = "test";

import jwt from "jsonwebtoken";
import request from "supertest";
import { accessTable, collectRoutes, passes, permissionTable, reachableRoutes } from "../testSupport/routeAccess.js";
import { P, PERMISSION_KEYS, SYSTEM_ROLES, systemRoleByName } from "../utils/permissions.js";

// Handlers answer 200 at once: the live requests below test the gates only.
const stubAll = (path) => {
  const actual = jest.requireActual(path);
  const ok = (req, res) => res.json({ ok: true });
  return { __esModule: true, ...Object.fromEntries(Object.keys(actual).map((k) => [k, typeof actual[k] === "function" ? ok : actual[k]])) };
};
jest.mock("../controllers/generalController.js", () => stubAll("../controllers/generalController.js"));
jest.mock("../controllers/accountController.js", () => stubAll("../controllers/accountController.js"));
jest.mock("../controllers/communicationController.js", () => stubAll("../controllers/communicationController.js"));

const app = require("../index.js").default;
const store = require("../services/accessStore.js"); // the in-memory fake (testSupport/jestSetup.js)
const { clearAccessCache } = require("../services/officeAccess.js");

const permsOf = (name) => new Set(systemRoleByName(name).permissions);
const SYSTEM = { A: permsOf("Administrator"), CT: permsOf("Class Teacher"), Acc: permsOf("Accountant") };

const BEFORE = {
  "GET /?$/": "*",
  "POST /signin": "*",
  "POST /signup": "*",
  "POST /signin-management": "*",
  "POST /signup-management": "A",
  "GET /signup-staff-list": "A",
  "GET /send-otp/:userId": "*",
  "POST /reset-password": "*",
  "POST /get-pin": "*",
  "POST /update-pin": "*",
  "POST /verify-pin": "*",
  "GET /school": "*",
  "GET /school/logo": "*",
  "GET /school/settings": "A",
  "PUT /school": "A",
  "POST /school/logo": "A",
  "DELETE /school/logo": "A",
  "GET /school/admission-preview": "A",
  "GET /students/next-admission-no": "A",
  "GET /result": "*",
  "GET /result-details": "*",
  "GET /nursery-result": "*",
  "GET /feecheck": "*",
  "GET /last-fee-paid": "*",
  "GET /auth/google": "*",
  "GET /oauth/callback": "*",
  "GET /download/:fileId": "*",
  "GET /files": "*",
  "GET /get-assignment": "*",
  "POST /upload": "*",
  "DELETE /delete-file/:fileId": "*",
  "GET /user-details": "*",
  "GET /news": "*",
  "GET /class": "*",
  "GET /subject": "*",
  "GET /portal/timetable": "*",
  "GET /portal/photo": "*",
  "GET /portal/terms": "*",
  "GET /portal/attendance": "*",
  "GET /events": "*",
  "GET /posts": "*",
  "POST /posts": "A CT",
  "GET /posts/:id": "*",
  "PUT /posts/:id": "A CT",
  "DELETE /posts/:id": "A CT",
  "POST /posts/:id/publish": "A CT",
  "POST /posts/:id/draft": "A CT",
  "POST /posts/:id/archive": "A CT",
  "POST /posts/:id/pin": "A CT",
  "GET /posts/:id/image": "*",
  "POST /posts/:id/image": "A CT",
  "DELETE /posts/:id/image": "A CT",
  "POST /posts/:id/like": "*",
  "GET /posts/:id/comments": "*",
  "POST /posts/:id/comments": "*",
  "DELETE /posts/:id/comments/:commentId": "*",
  "POST /posts/:id/comments/:commentId/hide": "*",
  "GET /posts/:id/results": "*",
  "POST /posts/:id/vote": "*",
  "GET /notification-settings": "A",
  "PUT /notification-settings": "A",
  "GET /notifications/email-log": "A",
  "POST /notifications/results-ready": "A CT",
  "POST /notifications/scores-reminder": "A",
  "GET /notifications": "*",
  "GET /notifications/unread-count": "*",
  "PATCH /notifications/read-all": "*",
  "PATCH /notifications/:id/read": "*",
  "GET /teacher/my-classes": "*",
  "GET /teacher/register": "*",
  "POST /teacher/register": "*",
  "GET /teacher/scores": "*",
  "POST /teacher/scores": "*",
  "GET /teacher/kg-ratings": "*",
  "POST /teacher/kg-ratings": "*",
  "GET /portal/invoices/": "*",
  "GET /portal/invoices/:id": "*",
  "GET /dashboard-summary": "A CT Acc",
  "GET /students-owing": "A CT Acc",
  "GET /news #2": "A CT Acc",
  "GET /user-details #2": "*",
  "GET /class #2": "A CT Acc",
  "GET /subject #2": "A CT",
  "GET /events #2": "A CT Acc",
  "GET /active-term": "A CT Acc",
  "GET /terms": "A CT Acc",
  "POST /close-term": "A",
  "GET /promotion/rules": "A",
  "PUT /promotion/rules": "A",
  "GET /promotion/class-order": "A",
  "PUT /promotion/class-order": "A",
  "GET /promotion/preview": "A",
  "POST /promotion/accept": "A",
  "GET /promotion/status": "A",
  "GET /promotion/history/:studentId": "A CT",
  "GET /staff": "A",
  "GET /students": "A CT Acc",
  "GET /student-results": "A CT",
  "GET /student-marks": "A CT",
  "GET /kg-assessment": "A CT",
  "GET /student-kg-results": "A CT",
  "GET /report-cards/completeness": "A CT",
  "GET /report-cards/class": "A CT",
  "GET /class-results/year": "A CT",
  "GET /student-attendance": "A CT",
  "GET /student-attendance-count": "A CT",
  "GET /student-total-attendance": "A CT",
  "GET /attendance-summary": "A CT",
  "GET /calculate-term-attendance": "A",
  "GET /fees": "A Acc",
  "GET /fees/:fee_id": "A Acc",
  "POST /fees/:fee_id/reverse": "A",
  "GET /feeding": "A Acc",
  "GET /extra-classes": "A Acc",
  "GET /bus-fee": "A Acc",
  "GET /salary": "A Acc",
  "GET /salary/:salary_id": "A Acc",
  "GET /salary-payment": "A Acc",
  "GET /employee-salary": "A Acc",
  "POST /add-student": "A",
  "POST /add-class": "A",
  "POST /add-staff": "A",
  "POST /add-result": "A CT",
  "POST /add-single-subject-result": "A CT",
  "POST /upsert-single-subject-result": "A CT",
  "POST /add-kg-result": "A CT",
  "POST /add-fee": "A Acc",
  "POST /add-subject": "A",
  "POST /add-salary": "A Acc",
  "POST /add-salary-payment": "A Acc",
  "POST /add-feeding": "A Acc",
  "POST /add-bus-fee": "A Acc",
  "POST /add-extra-classes": "A Acc",
  "POST /add-class-fee": "A Acc",
  "POST /add-student-fee": "A Acc",
  "POST /add-term": "A",
  "POST /add-news": "A",
  "GET /teaching-assignments": "A",
  "POST /teaching-assignments": "A",
  "POST /teaching-assignments/copy": "A",
  "DELETE /teaching-assignments/:id": "A",
  "GET /grading-scales": "A CT",
  "GET /grading-scales/for-class": "A CT",
  "POST /grading-scales": "A",
  "PUT /grading-scales/:id": "A",
  "DELETE /grading-scales/:id": "A",
  "GET /class-subject-scores": "A CT",
  "POST /class-subject-scores": "A CT",
  "GET /timetable/periods": "A CT Acc",
  "PUT /timetable/periods": "A",
  "POST /timetable/bulk": "A",
  "POST /timetable/copy": "A",
  "POST /timetable/sync-assignments": "A",
  "GET /timetable": "A CT Acc",
  "POST /timetable": "A",
  "PUT /timetable/:id": "A",
  "DELETE /timetable/:id": "A",
  "POST /mark-attendance": "A CT",
  "POST /delete-attendance": "A CT",
  "POST /assign-salary": "A Acc",
  "PUT /update-student/:student_id": "A",
  "PUT /update-staff/:teacher_id": "A",
  "PUT /update-class-fee/:class_fee_id": "A Acc",
  "PUT /update-student-fee/:student_fee_id": "A Acc",
  "PUT /update-class/:class_id": "A",
  "PUT /update-term/:term_id": "A",
  "PUT /update-news/:news_id": "A",
  "PUT /update-salary/:salary_id": "A Acc",
  "DELETE /delete-student/:student_id": "A",
  "DELETE /delete-staff/:teacher_id": "A",
  "DELETE /delete-class/:class_id": "A",
  "DELETE /delete-class-fee/:class_fee_id": "A Acc",
  "DELETE /delete-student-fee/:student_fee_id": "A Acc",
  "DELETE /delete-result": "A CT",
  "DELETE /delete-fee/:fee_id": "A Acc",
  "DELETE /delete-subject/:subject_id": "A",
  "DELETE /delete-salary/:salary_id": "A Acc",
  "DELETE /delete-salary-payment/:payment_id": "A Acc",
  "DELETE /delete-feeding/:feeding_id": "A Acc",
  "DELETE /delete-extra-classes/:extraclasses_id": "A Acc",
  "DELETE /delete-bus-fee/:busfee_id": "A Acc",
  "DELETE /delete-news/:news_id": "A",
  "GET /expense-graph": "A Acc",
  "GET /income-graph": "A Acc",
  "GET /fees-graph": "A Acc",
  "GET /fees-vs-expense-graph": "A Acc",
  "GET /profit-loss": "A Acc",
  "GET /academic-years": "A CT Acc",
  "GET /academic-years/:id": "A CT Acc",
  "POST /academic-years": "A",
  "PATCH /academic-years/:id": "A",
  "DELETE /academic-years/:id": "A",
  "POST /academic-years/:id/set-current": "A",
  "POST /academic-years/:id/terms": "A",
  "POST /terms/:id/activate": "A",
  "DELETE /terms/:id": "A",
  "GET /discount-types": "A Acc",
  "POST /discount-types": "A",
  "PATCH /discount-types/:id": "A",
  "DELETE /discount-types/:id": "A",
  "GET /student-discounts/sibling-suggestions": "A Acc",
  "GET /student-discounts": "A Acc",
  "POST /student-discounts": "A Acc",
  "PATCH /student-discounts/:id": "A Acc",
  "DELETE /student-discounts/:id": "A Acc",
  "GET /term-billing/:termId/preview": "A Acc",
  "POST /term-billing/:termId/bill": "A Acc",
  "GET /fee-statement/:studentId": "A Acc",
  "GET /students/:id/photo": "A CT",
  "POST /students/:id/photo": "A CT",
  "DELETE /students/:id/photo": "A CT",
  "GET /students/:id/documents": "A CT",
  "POST /students/:id/documents": "A CT",
  "GET /students/:id/documents/:docId/file": "A CT",
  "DELETE /students/:id/documents/:docId": "A CT",
  "GET /staff/:id/photo": "A",
  "POST /staff/:id/photo": "A",
  "DELETE /staff/:id/photo": "A",
  "GET /staff/:id/documents": "A",
  "POST /staff/:id/documents": "A",
  "GET /staff/:id/documents/:docId/file": "A",
  "DELETE /staff/:id/documents/:docId": "A",
  "GET /staff-attendance": "A",
  "POST /staff-attendance": "A",
  "GET /staff-attendance/summary": "A",
  "GET /staff-attendance/:teacherId/summary": "A",
  "GET /reports/academic/terms-overview": "A",
  "GET /reports/academic/term/:termId": "A",
  "GET /reports/academic/term/:termId/class/:classId": "A CT",
  "GET /invoices": "A Acc",
  "GET /invoices/print": "A Acc",
  "POST /invoices/generate": "A Acc",
  "POST /invoices/bulk": "A Acc",
  "GET /invoices/:id": "A Acc",
  "POST /invoices/:id/issue": "A Acc",
  "POST /invoices/:id/void": "A Acc",
  "GET /credit-notes": "A Acc",
  "POST /credit-notes": "A",
  "POST /credit-notes/:id/void": "A",
  "GET /expense": "A Acc",
  "POST /add-expense": "A Acc",
  "DELETE /delete-expense/:expense_id": "A Acc",
  "GET /income": "A Acc",
  "POST /add-income": "A Acc",
  "DELETE /delete-income/:income_id": "A Acc",
  "GET /account-category": "A Acc",
  "POST /add-account-category": "A Acc",
  "DELETE /delete-account-category/:account_category_id": "A Acc",
  "POST /communication/send-sms": "A",
  // B10 (new): roles and office logins' roles; the caller's own access.
  "GET /my-access": "*",
  "GET /permissions": "A",
  "GET /roles": "A",
  "GET /roles/:id": "A",
  "POST /roles": "A",
  "PUT /roles/:id": "A",
  "DELETE /roles/:id": "A",
  "GET /office-logins": "A",
  "PUT /office-logins/:username/role": "A",
  // AI (feature/ai-work, before B10): status for any signed-in user; settings,
  // usage, drafts, announcements, briefings and the papers view Administrator
  // only; Ask Administrator + Accountant; the watchlist Administrator + Class
  // Teacher (own class, checked in the service). The portal's /teacher/papers*
  // sit inside teacherRouter (STAFF tokens) and are not office routes.
  "GET /ai/status": "*",
  "GET /ai/settings": "A",
  "PUT /ai/settings": "A",
  "GET /ai/usage": "A",
  "GET /ai/suggestions": "A",
  "GET /ai/suggestions/:id": "A",
  "PATCH /ai/suggestions/:id": "A",
  "POST /ai/suggestions/:id/accept": "A",
  "POST /ai/suggestions/:id/reject": "A",
  "POST /ai/announcements/draft": "A",
  "POST /ai/chat": "A Acc",
  "GET /ai/conversations": "A Acc",
  "GET /ai/conversations/:id": "A Acc",
  "DELETE /ai/conversations/:id": "A Acc",
  "GET /question-papers": "A",
  "GET /question-papers/:id": "A",
  "GET /ai/briefings/latest": "A",
  "GET /ai/briefings/settings": "A",
  "PUT /ai/briefings/settings": "A",
  "POST /ai/briefings/run": "A",
  "GET /ai/briefings": "A",
  "GET /ai/briefings/:id": "A",
  "GET /ai/watchlist": "A CT",
  "POST /ai/watchlist/notes": "A CT",
  "PUT /ai/watchlist/:studentId/status": "A CT",
};

// Every AI route and the one permission that gates it (on purpose: a new AI
// route fails here until it is added).
const AI_GATES = {
  "GET /ai/settings": "ai.settings",
  "PUT /ai/settings": "ai.settings",
  "GET /ai/usage": "ai.settings",
  "GET /ai/suggestions": "ai.suggestions.review",
  "GET /ai/suggestions/:id": "ai.suggestions.review",
  "PATCH /ai/suggestions/:id": "ai.suggestions.review",
  "POST /ai/suggestions/:id/accept": "ai.suggestions.review",
  "POST /ai/suggestions/:id/reject": "ai.suggestions.review",
  "POST /ai/announcements/draft": "ai.announcements",
  "POST /ai/chat": "ai.ask",
  "GET /ai/conversations": "ai.ask",
  "GET /ai/conversations/:id": "ai.ask",
  "DELETE /ai/conversations/:id": "ai.ask",
  "GET /question-papers": "ai.papers.view_all",
  "GET /question-papers/:id": "ai.papers.view_all",
  "GET /ai/briefings/latest": "ai.briefing",
  "GET /ai/briefings/settings": "ai.briefing",
  "PUT /ai/briefings/settings": "ai.briefing",
  "POST /ai/briefings/run": "ai.briefing",
  "GET /ai/briefings": "ai.briefing",
  "GET /ai/briefings/:id": "ai.briefing",
  "GET /ai/watchlist": "ai.at_risk",
  "POST /ai/watchlist/notes": "ai.at_risk",
  "PUT /ai/watchlist/:studentId/status": "ai.at_risk",
};

const now = accessTable(app, SYSTEM);
const routes = collectRoutes(app);
const OPEN = Object.keys(BEFORE).filter((k) => BEFORE[k] === "*");

describe("router walk: the system roles reach exactly what they did before B10", () => {
  it("covers the same routes as the snapshot (add a new route to BEFORE on purpose)", () => {
    expect(Object.keys(now).sort()).toEqual(Object.keys(BEFORE).sort());
  });

  it.each(Object.keys(BEFORE))("%s: Administrator, Class Teacher and Accountant as before", (key) => {
    expect(now[key]).toBe(BEFORE[key]);
  });
});

describe("router walk: every route has a permission", () => {
  it("only public, portal and caller's-own routes have no permission gate", () => {
    const ungated = routes.filter((r) => !r.gates.length).map((r) => r.key);
    expect(ungated.sort()).toEqual([...OPEN].sort());
    // and none of those is an office route but the caller's own access
    const office = OPEN.filter((k) => !/^(GET|POST) \/(signin|signup|send-otp|reset-password|get-pin|update-pin|verify-pin|school|result|nursery-result|feecheck|last-fee-paid|auth|oauth|download|files|get-assignment|upload|delete-file|user-details|news|class|subject|portal|events|posts|notifications|teacher|\?\$)/.test(k) && !/^(PUT|PATCH|DELETE) \/(posts|notifications|delete-file)/.test(k));
    // ...and the caller's own AI status (any signed-in user, portal too; it lists only what they may use)
    expect(office).toEqual(["GET /my-access", "GET /ai/status"]);
  });

  it("every gate names catalogue keys only", () => {
    for (const { gates } of routes) for (const keys of gates) for (const k of keys) expect(PERMISSION_KEYS).toContain(k);
  });

  it("every catalogue key guards a route, or is a reach permission checked in the services", () => {
    const used = new Set(routes.flatMap((r) => r.gates.flat()));
    const reach = [P.ALL_CLASSES, P.EDIT_CLOSED_TERMS, P.STAFF_VIEW_SENSITIVE];
    expect(PERMISSION_KEYS.filter((k) => !used.has(k) && !reach.includes(k))).toEqual([]);
  });

  it("the Administrator role holds every permission; the system roles hold catalogue keys only", () => {
    expect([...SYSTEM.A].sort()).toEqual([...PERMISSION_KEYS].sort());
    for (const r of SYSTEM_ROLES) for (const k of r.permissions) expect(PERMISSION_KEYS).toContain(k);
  });
});

describe("router walk: AI routes (B10 permissions)", () => {
  const table = permissionTable(app);

  it("every AI office route is gated by its one AI permission", () => {
    const aiRoutes = routes.map((r) => r.key).filter((k) => /^\w+ \/(ai\/|question-papers)/.test(k) && k !== "GET /ai/status");
    expect(aiRoutes.sort()).toEqual(Object.keys(AI_GATES).sort());
    for (const [k, key] of Object.entries(AI_GATES)) expect([k, table[k]]).toEqual([k, key]);
  });

  it("the system roles hold the AI keys they had as roles before B10", () => {
    const ai = (perms) => [...perms].filter((k) => k.startsWith("ai.")).sort();
    expect(ai(SYSTEM.A)).toEqual(PERMISSION_KEYS.filter((k) => k.startsWith("ai.")).sort());
    expect(ai(SYSTEM.Acc)).toEqual(["ai.ask"]);
    expect(ai(SYSTEM.CT)).toEqual(["ai.at_risk"]);
  });

  it("a custom role with ai.ask + fees.view reaches Ask and nothing else of AI", () => {
    const ai = reachableRoutes(app, ["ai.ask", "fees.view"]).filter((k) => / \/(ai|question-papers)/.test(k));
    expect(ai.sort()).toEqual(["POST /ai/chat", "GET /ai/conversations", "GET /ai/conversations/:id", "DELETE /ai/conversations/:id"].sort());
  });
});

describe("router walk: custom roles", () => {
  it("a role with no permissions reaches nothing", () => {
    expect(reachableRoutes(app, [])).toEqual([]);
  });

  it("a role with a few permissions reaches exactly those routes", () => {
    expect(reachableRoutes(app, ["fees.view", "overview.lookups"]).sort()).toEqual(
      ["GET /students", "GET /timetable", "GET /timetable/periods", "GET /fees", "GET /fees/:fee_id", "GET /fee-statement/:studentId"].sort()
    );
    expect(reachableRoutes(app, ["staff_attendance.view"]).sort()).toEqual(
      ["GET /staff-attendance", "GET /staff-attendance/summary", "GET /staff-attendance/:teacherId/summary"].sort()
    );
    expect(reachableRoutes(app, ["billing.discount_types"]).sort()).toEqual(
      ["GET /discount-types", "POST /discount-types", "PATCH /discount-types/:id", "DELETE /discount-types/:id"].sort()
    );
  });

  it("each permission alone opens only the routes that name it", () => {
    for (const key of PERMISSION_KEYS) {
      const expected = routes.filter((r) => r.gates.length && r.gates.every((g) => g.includes(key))).map((r) => r.key);
      expect([key, reachableRoutes(app, [key]).sort()]).toEqual([key, expected.sort()]);
    }  });

  it("an Accountant cannot reach any results write", () => {
    for (const k of ["POST /add-result", "POST /add-single-subject-result", "POST /upsert-single-subject-result", "POST /add-kg-result", "POST /class-subject-scores", "DELETE /delete-result"]) {
      const r = routes.find((x) => x.key === k);
      expect([k, passes(r.gates, SYSTEM.Acc)]).toEqual([k, false]);
    }
  });
});

// The walk reads the gates; the real middleware must agree, with permissions
// loaded on the server (never from the token).
describe("live requests (gates only; handlers stubbed)", () => {
  const sign = (p) => jwt.sign(p, "test-secret", { algorithm: "HS256", expiresIn: "1h" });
  const call = (method, path, token) => request(app)[method](path).set("Authorization", `Bearer ${token}`).send({});

  beforeEach(() => {
    store.reset();
    clearAccessCache();
    store.addRole({ roleId: 9, name: "Bursar's clerk", permissions: ["fees.view", "students.view"] });
    store.addRole({ roleId: 10, name: "Nobody", permissions: [] });
  });

  it("a token from before B10 (category only, no roleId) works as its system role", async () => {
    const acc = sign({ category: "Accountant", username: "bursar" });
    expect((await call("get", "/fees", acc)).status).toBe(200);
    expect((await call("post", "/add-expense", acc)).status).toBe(200);
    expect((await call("post", "/fees/1/reverse", acc)).status).toBe(403);
    expect((await call("post", "/add-result", acc)).status).toBe(403);
    const ct = sign({ category: "Class Teacher", username: "ct", teacherId: 3 });
    expect((await call("get", "/fees", ct)).status).toBe(403);
    expect((await call("get", "/expense", ct)).status).toBe(403);
    expect((await call("post", "/communication/send-sms", ct)).status).toBe(403);
    const admin = sign({ category: "Administrator", username: "admin" });
    expect((await call("post", "/communication/send-sms", admin)).status).toBe(200);
  });

  it("a custom role reaches its routes and nothing else", async () => {
    const t = sign({ category: "Bursar's clerk", username: "clerk", roleId: 9 });
    expect((await call("get", "/fees", t)).status).toBe(200);
    expect((await call("get", "/students", t)).status).toBe(200);
    for (const [m, p] of [["post", "/add-fee"], ["get", "/expense"], ["get", "/dashboard-summary"], ["get", "/roles"], ["post", "/communication/send-sms"], ["get", "/salary"]]) {
      expect([m, p, (await call(m, p, t)).status]).toEqual([m, p, 403]);
    }
  });

  it("a role with no permissions gets 403 everywhere but its own access", async () => {
    const t = sign({ category: "Nobody", username: "nobody", roleId: 10 });
    for (const [m, p] of [["get", "/dashboard-summary"], ["get", "/class"], ["get", "/terms"], ["get", "/news"], ["post", "/posts"], ["get", "/posts"], ["get", "/events?month=2026-11"], ["get", "/staff-attendance"]]) {
      expect([m, p, (await call(m, p, t)).status]).toEqual([m, p, 403]);
    }
    const me = await call("get", "/my-access", t);
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ username: "nobody", roleId: 10, roleName: "Nobody", permissions: [] });
  });

  it("the account's role in the database wins over the token's claims", async () => {
    // Token says Administrator (signed before the role changed); the login is now a clerk.
    store.addAccount({ username: "former-admin", roleId: 9, category: "Bursar's clerk" });
    const t = sign({ category: "Administrator", username: "former-admin", roleId: 1 });
    expect((await call("post", "/add-student", t)).status).toBe(403);
    expect((await call("get", "/fees", t)).status).toBe(200);
  });

  it("an account with no role_id maps by its stored category", async () => {
    store.addAccount({ username: "acc", roleId: null, category: "Accountant" });
    const t = sign({ category: "Administrator", username: "acc" });
    expect((await call("get", "/fees", t)).status).toBe(200);
    expect((await call("post", "/fees/1/reverse", t)).status).toBe(403);
  });

  it("a removed login (no account row) reaches nothing, even with roleId 1", async () => {
    store.removeAccount("ghost");
    const t = sign({ category: "Administrator", username: "ghost", roleId: 1 });
    expect((await call("get", "/dashboard-summary", t)).status).toBe(403);
    expect((await call("post", "/add-student", t)).status).toBe(403);
    expect((await call("get", "/my-access", t)).body).toMatchObject({ roleId: null, permissions: [] });
  });

  it("an archived account reaches nothing, whatever its token says", async () => {
    store.addAccount({ username: "gone", roleId: 1, category: "Administrator", isDeleted: true });
    const t = sign({ category: "Administrator", username: "gone", roleId: 1 });
    expect((await call("get", "/dashboard-summary", t)).status).toBe(403);
    expect((await call("post", "/add-student", t)).status).toBe(403);
    expect((await call("get", "/posts", t)).status).toBe(403); // the news feed too
  });

  it("permissions written into a token are ignored", async () => {
    const t = sign({ category: "Class Teacher", username: "ct2", teacherId: 3, permissions: [...PERMISSION_KEYS] });
    expect((await call("get", "/fees", t)).status).toBe(403);
    expect((await call("post", "/add-student", t)).status).toBe(403);
  });

  it("an unknown category or role id reaches nothing", async () => {
    for (const claims of [{ category: "Head Teacher", username: "ht" }, { category: "administrator", username: "lc" }, { category: "X", username: "x", roleId: 999 }]) {
      const t = sign(claims);
      expect([claims, (await call("get", "/dashboard-summary", t)).status]).toEqual([claims, 403]);
    }
  });

  it("a portal token never reaches an office route", async () => {
    const stu = sign({ id: 1, userRole: "STU" });
    expect((await call("get", "/fees", stu)).status).toBe(403);
    expect((await call("get", "/my-access", stu)).status).toBe(403);
  });
});
