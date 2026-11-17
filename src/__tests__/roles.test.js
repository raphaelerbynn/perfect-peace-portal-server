// B10: roles and office logins' roles (services/roles.js) on an in-memory
// table: system roles are read-only, a role in use can't be deleted, the last
// holder of roles.manage is protected, nobody hands out more than they hold,
// renaming keeps category in step, unknown keys are refused.
import { Op } from "sequelize";

jest.mock("../config/database.js", () => ({
  __esModule: true,
  default: {
    transaction: async (fn) => fn({ LOCK: { UPDATE: "UPDATE" } }),
    query: jest.fn(async () => [[]]),
    where: (left, value) => ({ __nameIs: value }),
    fn: () => ({}),
    col: () => ({}),
  },
}));

// ---------------------------------------------------------------- tiny table
const db = { roles: [], grants: [], accounts: [] };
const matches = (row, where) => {
  if (!where) return true;
  if (where.__nameIs !== undefined) return row.name.trim().toLowerCase() === where.__nameIs;
  for (const s of Object.getOwnPropertySymbols(where)) {
    if (s === Op.and) { if (!where[s].every((w) => matches(row, w))) return false; }
    else if (s === Op.or) { if (!where[s].some((w) => matches(row, w))) return false; }
  }
  for (const [k, cond] of Object.entries(where)) {
    const v = row[k];
    if (cond !== null && typeof cond === "object") {
      for (const s of Object.getOwnPropertySymbols(cond)) {
        if (s === Op.in && !cond[s].includes(v)) return false;
        if (s === Op.ne && v === cond[s]) return false;
        if (s === Op.not && v === cond[s]) return false;
        if (s === Op.notIn && cond[s].includes(v)) return false;
      }
    } else if ((v ?? null) !== cond) return false;
  }
  return true;
};
const table = (name, pk) => ({
  findAll: jest.fn(async ({ where } = {}) => db[name].filter((r) => matches(r, where)).map((r) => ({ ...r }))),
  findOne: jest.fn(async ({ where } = {}) => db[name].find((r) => matches(r, where)) ?? null),
  findByPk: jest.fn(async (id) => db[name].find((r) => r[pk] === id) ?? null),
  count: jest.fn(async ({ where } = {}) => db[name].filter((r) => matches(r, where)).length),
  update: jest.fn(async (changes, { where }) => {
    const hit = db[name].filter((r) => matches(r, where));
    hit.forEach((r) => Object.assign(r, changes));
    return [hit.length];
  }),
  destroy: jest.fn(async ({ where }) => {
    const before = db[name].length;
    db[name] = db[name].filter((r) => !matches(r, where));
    return before - db[name].length;
  }),
});
jest.mock("../models/index.js", () => ({ __esModule: true, Role: {}, RolePermission: {}, UserAccount: {}, Teacher: {} }));
import { Role, RolePermission, UserAccount } from "../models/index.js";
Object.assign(Role, table("roles", "roleId"), {
  create: jest.fn(async (v) => {
    const row = { roleId: Math.max(3, ...db.roles.map((r) => r.roleId)) + 1, ...v };
    db.roles.push(row);
    return row;
  }),
});
Object.assign(RolePermission, table("grants", "roleId"), {
  bulkCreate: jest.fn(async (rows) => db.grants.push(...rows)),
});
Object.assign(UserAccount, table("accounts", "username"));

import * as roles from "../services/roles.js";
import { officeUser } from "../testSupport/officeUser.js";
import { PERMISSION_KEYS } from "../utils/permissions.js";

const admin = officeUser("Administrator", { username: "admin" });
const SYSTEM_ROWS = [
  { roleId: 1, name: "Administrator", isSystem: true },
  { roleId: 2, name: "Class Teacher", isSystem: true },
  { roleId: 3, name: "Accountant", isSystem: true },
];

beforeEach(() => {
  db.roles = SYSTEM_ROWS.map((r) => ({ ...r }));
  db.grants = [];
  db.accounts = [
    { username: "admin", roleId: 1, category: "Administrator", isDeleted: false },
    { username: "ct", roleId: 2, category: "Class Teacher", isDeleted: false },
    { username: "bursar", roleId: null, category: "Accountant", isDeleted: false }, // not backfilled yet
  ];
});

describe("catalogue", () => {
  it("lists every key once, grouped by module, with a plain label", () => {
    const { modules } = roles.listPermissions();
    const keys = modules.flatMap((m) => m.permissions.map((p) => p.key));
    expect(keys.sort()).toEqual([...PERMISSION_KEYS].sort());
    for (const m of modules) {
      expect(m.label).toBeTruthy();
      for (const p of m.permissions) {
        expect(p.key.startsWith(`${m.key}.`)).toBe(true);
        expect(p.label.length).toBeGreaterThan(8);
      }
    }
  });
});

describe("listing", () => {
  it("system roles first with their code permissions and user counts (category-only logins count)", async () => {
    await roles.createRole({ name: "Head Teacher", permissions: ["results.view"] }, admin);
    const list = await roles.listRoles();
    expect(list.map((r) => r.name)).toEqual(["Administrator", "Class Teacher", "Accountant", "Head Teacher"]);
    expect(list[0].permissions).toHaveLength(PERMISSION_KEYS.length);
    expect(list[2]).toMatchObject({ isSystem: true, userCount: 1 }); // bursar, by category
    expect(list[3]).toMatchObject({ isSystem: false, permissions: ["results.view"], userCount: 0 });
  });
});

describe("create", () => {
  it("makes a custom role with its permissions", async () => {
    const r = await roles.createRole({ name: "  Head   Teacher ", description: "Academics", permissions: ["results.view", "results.view", "academics.all_classes"] }, admin);
    expect(r).toMatchObject({ name: "Head Teacher", isSystem: false, permissions: ["academics.all_classes", "results.view"], createdBy: "admin" });
  });

  it("refuses a name in use (any case) and a built-in name", async () => {
    await roles.createRole({ name: "Bursar" }, admin);
    await expect(roles.createRole({ name: "bursar " }, admin)).rejects.toMatchObject({ statusCode: 409 });
    await expect(roles.createRole({ name: "administrator" }, admin)).rejects.toMatchObject({ statusCode: 409 });
    await expect(roles.createRole({ name: "  " }, admin)).rejects.toMatchObject({ statusCode: 400 });
    await expect(roles.createRole({ name: "x".repeat(51) }, admin)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("a role that creates logins must also have every class (no borrowing another teacher's class)", async () => {
    await expect(roles.createRole({ name: "Clerk", permissions: ["users.manage"] }, admin)).rejects.toMatchObject({ statusCode: 400 });
    await expect(roles.createRole({ name: "Clerk", permissions: ["users.manage", "academics.all_classes"] }, admin)).resolves.toMatchObject({ name: "Clerk" });
  });

  it("refuses unknown permission keys", async () => {
    await expect(roles.createRole({ name: "X", permissions: ["fees.view", "fees.steal"] }, admin)).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("fees.steal"),
    });
    await expect(roles.createRole({ name: "X", permissions: "fees.view" }, admin)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("a caller can't create a role with permissions they don't hold", async () => {
    const lead = officeUser("Role editor", { username: "lead" }, ["roles.manage", "results.view"]);
    await expect(roles.createRole({ name: "Y", permissions: ["results.view"] }, lead)).resolves.toMatchObject({ name: "Y" });
    await expect(roles.createRole({ name: "Z", permissions: ["fees.reverse"] }, lead)).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("system roles are read-only", () => {
  it.each([1, 2, 3])("role %i can't be edited or deleted", async (id) => {
    await expect(roles.updateRole(id, { name: "Boss" }, admin)).rejects.toMatchObject({ statusCode: 400 });
    await expect(roles.updateRole(id, { permissions: [] }, admin)).rejects.toMatchObject({ statusCode: 400 });
    await expect(roles.deleteRole(id, admin)).rejects.toMatchObject({ statusCode: 400 });
    expect(db.roles.find((r) => r.roleId === id).name).toBe(SYSTEM_ROWS[id - 1].name);
  });
});

describe("edit", () => {
  it("replaces permissions; renaming updates category on every login with the role", async () => {
    const r = await roles.createRole({ name: "Head Teacher", permissions: ["results.view"] }, admin);
    db.accounts.push({ username: "head", roleId: r.roleId, category: "Head Teacher", isDeleted: false });
    const out = await roles.updateRole(r.roleId, { name: "Headmistress", permissions: ["results.enter", "attendance.view"] }, admin);
    expect(out).toMatchObject({ name: "Headmistress", permissions: ["attendance.view", "results.enter"], userCount: 1 });
    expect(db.accounts.find((a) => a.username === "head").category).toBe("Headmistress");
  });

  it("can't take a name another role has", async () => {
    await roles.createRole({ name: "A1" }, admin);
    const b = await roles.createRole({ name: "B1" }, admin);
    await expect(roles.updateRole(b.roleId, { name: "a1" }, admin)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("a caller can't edit a role holding permissions they don't have", async () => {
    const r = await roles.createRole({ name: "Finance lead", permissions: ["fees.reverse"] }, admin);
    const lead = officeUser("Role editor", { username: "lead" }, ["roles.manage", "results.view"]);
    await expect(roles.updateRole(r.roleId, { permissions: ["results.view"] }, lead)).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("delete", () => {
  it("an unused custom role is deleted with its permissions", async () => {
    const r = await roles.createRole({ name: "Temp", permissions: ["news.view"] }, admin);
    await expect(roles.deleteRole(r.roleId, admin)).resolves.toEqual({ deleted: 1 });
    expect(db.roles.find((x) => x.roleId === r.roleId)).toBeUndefined();
    expect(db.grants.filter((g) => g.roleId === r.roleId)).toEqual([]);
  });

  it("a role in use can't be deleted (archived logins count)", async () => {
    const r = await roles.createRole({ name: "Used", permissions: [] }, admin);
    db.accounts.push({ username: "old", roleId: r.roleId, category: "Used", isDeleted: true });
    await expect(roles.deleteRole(r.roleId, admin)).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining("1 office login has this role") });
  });
});

describe("the last holder of roles.manage is protected", () => {
  it("the only Administrator can't be moved to a role without roles.manage", async () => {
    await expect(roles.setLoginRole("admin", { roleId: 3 }, admin)).rejects.toMatchObject({ statusCode: 409 });
    expect(db.accounts.find((a) => a.username === "admin").roleId).toBe(1);
  });

  it("with a second holder, the first can be moved", async () => {
    db.accounts.push({ username: "admin2", roleId: 1, category: "Administrator", isDeleted: false });
    await roles.setLoginRole("admin", { roleId: 3 }, admin);
    expect(db.accounts.find((a) => a.username === "admin")).toMatchObject({ roleId: 3, category: "Accountant" });
  });

  it("an archived holder doesn't count", async () => {
    db.accounts.push({ username: "admin2", roleId: 1, category: "Administrator", isDeleted: true });
    await expect(roles.setLoginRole("admin", { roleId: 2 }, admin)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("a custom role that is the only holder can't lose roles.manage", async () => {
    const r = await roles.createRole({ name: "Owner", permissions: ["roles.manage", "users.manage", "academics.all_classes"] }, admin);
    db.accounts.push({ username: "owner", roleId: r.roleId, category: "Owner", isDeleted: false });
    db.accounts.find((a) => a.username === "admin").isDeleted = true; // the Administrator left
    await expect(roles.updateRole(r.roleId, { permissions: ["users.manage", "academics.all_classes"] }, admin)).rejects.toMatchObject({ statusCode: 409 });
    db.accounts.find((a) => a.username === "admin").isDeleted = false;
    await expect(roles.updateRole(r.roleId, { permissions: ["users.manage", "academics.all_classes"] }, admin)).resolves.toMatchObject({ permissions: ["academics.all_classes", "users.manage"] });
  });

  it("a holder counted by category alone (role_id not set yet) counts", async () => {
    db.accounts.push({ username: "admin2", roleId: null, category: "Administrator", isDeleted: false });
    await expect(roles.setLoginRole("admin", { roleId: 2 }, admin)).resolves.toMatchObject({ roleName: "Class Teacher" });
  });
});

describe("archiving a staff member's login", () => {
  it("refused when it is the last roles.manage holder", async () => {
    await expect(roles.assertManagersRemainWithout([{ username: "admin", roleId: 1, category: "Administrator", isDeleted: false }])).rejects.toMatchObject({ statusCode: 409 });
  });
  it("fine with another holder, or for a login without roles.manage, or one already archived", async () => {
    await expect(roles.assertManagersRemainWithout([{ username: "ct", roleId: 2, category: "Class Teacher" }])).resolves.toBeUndefined();
    await expect(roles.assertManagersRemainWithout([{ username: "admin", roleId: 1, isDeleted: true }])).resolves.toBeUndefined();
    db.accounts.push({ username: "admin2", roleId: 1, category: "Administrator", isDeleted: false });
    await expect(roles.assertManagersRemainWithout([{ username: "admin", roleId: 1, category: "Administrator" }])).resolves.toBeUndefined();
  });
});

describe("giving a login a role", () => {
  it("sets role_id and category together", async () => {
    const r = await roles.createRole({ name: "Head Teacher", permissions: ["results.view"] }, admin);
    await roles.setLoginRole("ct", { roleId: r.roleId }, admin);
    expect(db.accounts.find((a) => a.username === "ct")).toMatchObject({ roleId: r.roleId, category: "Head Teacher" });
  });

  it("never gives the built-in Administrator role (seed script only, as before B10)", async () => {
    db.accounts.push({ username: "admin2", roleId: 1, category: "Administrator", isDeleted: false });
    await expect(roles.setLoginRole("ct", { roleId: 1 }, admin)).rejects.toMatchObject({ statusCode: 403 });
    expect(db.accounts.find((a) => a.username === "ct").roleId).toBe(2);
  });

  it("refuses an unknown login or role", async () => {
    await expect(roles.setLoginRole("nobody", { roleId: 2 }, admin)).rejects.toMatchObject({ statusCode: 404 });
    await expect(roles.setLoginRole("ct", { roleId: 99 }, admin)).rejects.toMatchObject({ statusCode: 400 });
    await expect(roles.setLoginRole("ct", {}, admin)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("a caller with users.manage only can't give or take away more than they hold", async () => {
    const clerk = officeUser("Office clerk", { username: "clerk" }, ["users.manage", ...officeUser("Class Teacher").permissions]);
    // giving the Accountant role (fees) is beyond them
    await expect(roles.setLoginRole("ct", { roleId: 3 }, clerk)).rejects.toMatchObject({ statusCode: 403 });
    // changing the Administrator's login is beyond them
    await expect(roles.setLoginRole("admin", { roleId: 2 }, clerk)).rejects.toMatchObject({ statusCode: 403 });
    // a Class Teacher login to Class Teacher is fine
    await expect(roles.setLoginRole("ct", { roleId: 2 }, clerk)).resolves.toMatchObject({ roleId: 2 });
  });

  it("roleToGive takes a system role by its exact name (old office-login form)", async () => {
    await expect(roles.roleToGive({ category: "Accountant" }, admin)).resolves.toMatchObject({ roleId: 3, name: "Accountant" });
    await expect(roles.roleToGive({ category: "accountant" }, admin)).rejects.toMatchObject({ statusCode: 400 });
    await expect(roles.roleToGive({ category: "Head Teacher" }, admin)).rejects.toMatchObject({ statusCode: 400 });
  });
});
