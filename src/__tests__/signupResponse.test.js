// The office sign-up response must never include the password hash.
// B10: a new login gets a role (roleId, or a system role's name from the old
// form); the caller can only give a role whose permissions they hold.
jest.mock("../services/user.js", () => ({
  __esModule: true,
  findManagementUser: jest.fn(async () => null),
  signUpManagementUser: jest.fn(async (d) => ({ get: () => ({ username: d.username, category: d.category, roleId: d.roleId, password: "$2b$10$hash" }) })),
  getManagementUser: jest.fn(), getStudentUser: jest.fn(), getTeacherUser: jest.fn(),
  managementUserExistsForStaff: jest.fn(), studentSignUp: jest.fn(), teacherSignUp: jest.fn(),
}));
jest.mock("../models/index.js", () => ({
  __esModule: true,
  Role: { findByPk: jest.fn() },
  RolePermission: { findAll: jest.fn() },
  UserAccount: {},
  Teacher: {},
}));
import { signupManagement } from "../controllers/authController.js";
import { signUpManagementUser } from "../services/user.js";
import { Role, RolePermission } from "../models/index.js";
import { officeUser } from "../testSupport/officeUser.js";

const admin = officeUser("Administrator", { username: "admin" });
const call = async (body, user = admin) => {
  const res = { status: jest.fn(() => res), json: jest.fn() };
  const next = jest.fn();
  await signupManagement({ body, user }, res, next);
  return { res, next };
};
const base = { password: "teach1234", staffId: "9", email: "h@b.c" };

beforeEach(() => {
  Role.findByPk.mockResolvedValue(null);
  RolePermission.findAll.mockResolvedValue([]);
});

it("returns the account without its password", async () => {
  const { res, next } = await call({ ...base, username: "acc2", staffId: "2", category: "Accountant", email: "a@b.c" });
  expect(next).not.toHaveBeenCalled();
  const body = res.json.mock.calls[0][0];
  expect(body).toEqual({ message: "Login created", account: { username: "acc2", category: "Accountant", roleId: 3 } });
  expect(JSON.stringify(body)).not.toContain("$2b$");
});

it("a custom role by roleId: category is the role's name", async () => {
  Role.findByPk.mockResolvedValue({ roleId: 7, name: "Head Teacher", isSystem: false });
  RolePermission.findAll.mockResolvedValue([{ permissionKey: "results.view" }, { permissionKey: "academics.all_classes" }]);
  const { res, next } = await call({ ...base, username: "head", roleId: 7 });
  expect(next).not.toHaveBeenCalled();
  expect(signUpManagementUser).toHaveBeenCalledWith(expect.objectContaining({ username: "head", roleId: 7, category: "Head Teacher" }));
  expect(res.json.mock.calls[0][0].account).toEqual({ username: "head", category: "Head Teacher", roleId: 7 });
});

it("a system role by roleId", async () => {
  const { next } = await call({ ...base, username: "ct2", roleId: 2 });
  expect(next).not.toHaveBeenCalled();
  expect(signUpManagementUser).toHaveBeenCalledWith(expect.objectContaining({ roleId: 2, category: "Class Teacher" }));
});

// B10: Head Teacher is no longer a built-in role (make it as a custom role).
it.each(["Bursar", "head teacher", "Head Teacher", ""])("refuses the category %j (403)", async (category) => {
  const { res, next } = await call({ ...base, username: "x", category });
  expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: expect.any(Number) }));
  expect([400, 403]).toContain(next.mock.calls[0][0].statusCode);
  expect(res.json).not.toHaveBeenCalled();
});

it("refuses an unknown roleId", async () => {
  const { res, next } = await call({ ...base, username: "x", roleId: 99 });
  expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  expect(res.json).not.toHaveBeenCalled();
});

it("a caller can't give a role with permissions they don't hold", async () => {
  const lead = officeUser("Office lead", { username: "lead" }, ["users.manage", "students.view"]);
  const { next } = await call({ ...base, username: "x", category: "Accountant" }, lead);
  expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  expect(signUpManagementUser).not.toHaveBeenCalled();
});

// As before B10 (BE-A8): Administrator logins come from the seed script only.
it.each([{ roleId: 1 }, { category: "Administrator" }])("the built-in Administrator role is never given here (%j)", async (role) => {
  const { next } = await call({ ...base, username: "admin2", ...role });
  expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  expect(signUpManagementUser).not.toHaveBeenCalled();
});
