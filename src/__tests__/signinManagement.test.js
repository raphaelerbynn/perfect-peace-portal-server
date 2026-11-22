// B10: one office sign-in form. The account is found by username / email /
// staff/<id> across every role; the token carries the roleId (never the
// permissions); the response lists the permissions for the admin app.
process.env.JWT_KEY = "test-secret";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";

jest.mock("../models/index.js", () => ({ __esModule: true, UserAccount: { findAll: jest.fn() }, Role: {}, RolePermission: {}, Teacher: {} }));
import { UserAccount } from "../models/index.js";
import { signinManagement } from "../controllers/authController.js";
import { getManagementUser } from "../services/user.js";
import * as store from "../services/accessStore.js";
import { clearAccessCache } from "../services/officeAccess.js";

const hash = bcrypt.hashSync("right-pass", 4);
const row = (o) => ({ ...o, password: o.password ?? hash, get: () => ({ ...o, password: o.password ?? hash }) });

beforeEach(() => {
  store.reset();
  clearAccessCache();
});

const signin = async (body) => {
  const res = { status: jest.fn(() => res), send: jest.fn() };
  const next = jest.fn();
  await signinManagement({ body }, res, next);
  return { res, next, body: res.send.mock.calls[0]?.[0] };
};

it("signs in without a category; the token has roleId, the response the permissions", async () => {
  store.addAccount({ username: "bursar", roleId: 3, category: "Accountant" });
  UserAccount.findAll.mockResolvedValue([row({ username: "bursar", category: "Accountant", roleId: 3, teacherId: 4, email: "b@x.y" })]);
  const { body, next } = await signin({ username: "bursar", password: "right-pass" });
  expect(next).not.toHaveBeenCalled();
  expect(body).toMatchObject({ username: "bursar", category: "Accountant", roleId: 3, roleName: "Accountant", teacherId: 4 });
  expect(body.permissions).toContain("fees.record");
  expect(body.permissions).not.toContain("fees.reverse");
  const claims = jwt.decode(body.token);
  expect(claims).toMatchObject({ category: "Accountant", username: "bursar", teacherId: 4, roleId: 3 });
  expect(claims.permissions).toBeUndefined();
  // the lookup had no category filter
  expect(UserAccount.findAll.mock.calls[0][0].where.category).toBeUndefined();
});

it("a custom role: category in the token is the role's name", async () => {
  store.addRole({ roleId: 7, name: "Head Teacher", permissions: ["results.view"] });
  store.addAccount({ username: "head", roleId: 7, category: "Head Teacher" });
  UserAccount.findAll.mockResolvedValue([row({ username: "head", category: "Head Teacher", roleId: 7 })]);
  const { body } = await signin({ username: "head", password: "right-pass" });
  expect(body).toMatchObject({ category: "Head Teacher", roleId: 7, permissions: ["results.view"] });
});

it("an old client's category still narrows the lookup", async () => {
  UserAccount.findAll.mockResolvedValue([]);
  const { next } = await signin({ username: "x", password: "right-pass", category: "Class Teacher" });
  expect(UserAccount.findAll.mock.calls[0][0].where.category).toBe("Class Teacher");
  expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
});

it("wrong password: 401", async () => {
  UserAccount.findAll.mockResolvedValue([row({ username: "bursar", category: "Accountant", roleId: 3 })]);
  const { next } = await signin({ username: "bursar", password: "nope" });
  expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
});

describe("getManagementUser across roles", () => {
  it("an exact username wins over a staff/<id> match", async () => {
    UserAccount.findAll.mockResolvedValue([row({ username: "staff/4", category: "Accountant" }), row({ username: "other", teacherId: 4, category: "Class Teacher" })]);
    expect(await getManagementUser({ username: "staff/4", password: "right-pass" })).toMatchObject({ username: "staff/4" });
  });

  it("two logins of one staff member: the password picks the one", async () => {
    const other = bcrypt.hashSync("other-pass", 4);
    UserAccount.findAll.mockResolvedValue([row({ username: "ama.ct", teacherId: 4, category: "Class Teacher" }), row({ username: "ama.acc", teacherId: 4, category: "Accountant", password: other })]);
    expect(await getManagementUser({ username: "staff/4", password: "other-pass" })).toMatchObject({ username: "ama.acc" });
  });

  it("the same password on both: asked for the username (409)", async () => {
    UserAccount.findAll.mockResolvedValue([row({ username: "ama.ct", teacherId: 4 }), row({ username: "ama.acc", teacherId: 4 })]);
    await expect(getManagementUser({ username: "staff/4", password: "right-pass" })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("never returns the hash; no password = no user", async () => {
    UserAccount.findAll.mockResolvedValue([row({ username: "u" })]);
    expect(await getManagementUser({ username: "u", password: "right-pass" })).not.toHaveProperty("password");
    expect(await getManagementUser({ username: "u" })).toBeNull();
  });
});
