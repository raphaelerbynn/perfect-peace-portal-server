import { Role, RolePermission, UserAccount } from "../models/index.js";

// B10: the database reads behind officeAccess.js, kept apart so tests can
// swap them for an in-memory store (src/testSupport/jestSetup.js).

/** The office login's role link: { username, roleId, category, isDeleted } or null. */
export const findAccount = async (username) => {
  if (username == null || username === "") return null;
  const row = await UserAccount.findByPk(String(username), {
    attributes: ["username", "roleId", "category", "isDeleted"],
    raw: true,
  });
  return row || null;
};

/** A role row: { roleId, name, isSystem } or null. */
export const findRole = async (roleId) => {
  const row = await Role.findByPk(Number(roleId), { attributes: ["roleId", "name", "isSystem"], raw: true });
  return row || null;
};

/** A custom role's permission keys (as stored). */
export const rolePermissionKeys = async (roleId) => {
  const rows = await RolePermission.findAll({ where: { roleId: Number(roleId) }, attributes: ["permissionKey"], raw: true });
  return rows.map((r) => r.permissionKey);
};
