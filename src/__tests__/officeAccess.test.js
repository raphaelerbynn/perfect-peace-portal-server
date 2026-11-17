// B10: how an office login's permissions are worked out (services/officeAccess.js),
// with the in-memory access store (testSupport/fakeAccessStore.js).
import * as store from "../services/accessStore.js";
import { accessSummary, attachOfficeAccess, clearAccessCache, resolveAccess } from "../services/officeAccess.js";
import { PERMISSION_KEYS, systemRoleByName } from "../utils/permissions.js";

beforeEach(() => {
  store.reset();
  clearAccessCache();
});

const keys = async (user) => [...(await resolveAccess(user)).permissions].sort();

it("an old token (category only, no account row) gets its system role", async () => {
  expect(await keys({ category: "Accountant", username: "b" })).toEqual([...systemRoleByName("Accountant").permissions].sort());
  expect(await keys({ category: "Administrator", username: "a" })).toEqual([...PERMISSION_KEYS].sort());
});

it("unknown categories and lowercase names get nothing", async () => {
  expect(await keys({ category: "Head Teacher", username: "h" })).toEqual([]);
  expect(await keys({ category: "administrator", username: "x" })).toEqual([]);
  expect(await keys({ category: undefined, username: "x" })).toEqual([]);
});

it("the account row wins over the token; an archived account gets nothing", async () => {
  store.addRole({ roleId: 5, name: "Clerk", permissions: ["fees.view", "not.a_key"] });
  store.addAccount({ username: "u", roleId: 5, category: "Clerk" });
  expect(await resolveAccess({ category: "Administrator", username: "u", roleId: 1 })).toMatchObject({ roleId: 5, roleName: "Clerk", isSystem: false });
  expect(await keys({ category: "Administrator", username: "u", roleId: 1 })).toEqual(["fees.view"]); // unknown key dropped
  store.addAccount({ username: "gone", roleId: 1, category: "Administrator", isDeleted: true });
  expect(await keys({ category: "Administrator", username: "gone" })).toEqual([]);
});

it("a role change applies once the cache is cleared (the services clear it on every change)", async () => {
  store.addRole({ roleId: 6, name: "Tutor", permissions: ["results.view"] });
  store.addAccount({ username: "t", roleId: 6, category: "Tutor" });
  expect(await keys({ category: "Tutor", username: "t" })).toEqual(["results.view"]);
  store.addRole({ roleId: 6, name: "Tutor", permissions: ["results.view", "results.enter"] });
  expect(await keys({ category: "Tutor", username: "t" })).toEqual(["results.view"]); // cached
  clearAccessCache({ roleId: 6 });
  expect(await keys({ category: "Tutor", username: "t" })).toEqual(["results.enter", "results.view"]);
  store.addAccount({ username: "t", roleId: 3, category: "Accountant" });
  clearAccessCache({ username: "t" });
  expect((await resolveAccess({ category: "Tutor", username: "t" })).roleName).toBe("Accountant");
});

it("attachOfficeAccess puts a fresh copy on the user; the summary lists it sorted", async () => {
  const user = { category: "Class Teacher", username: "ct" };
  await attachOfficeAccess(user);
  user.permissions.add("fees.reverse"); // a caller mutating its copy...
  const again = await attachOfficeAccess({ category: "Class Teacher", username: "ct" });
  expect(again.permissions.has("fees.reverse")).toBe(false); // ...doesn't touch the cache
  expect(accessSummary(again)).toEqual({ roleId: 2, roleName: "Class Teacher", permissions: [...systemRoleByName("Class Teacher").permissions].sort() });
});
