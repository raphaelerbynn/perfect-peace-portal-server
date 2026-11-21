// B10: roles (Settings -> Roles) and which role each office login has
// (People -> Office logins).
//
// Rules:
//   - System roles (Administrator, Class Teacher, Accountant) are read-only:
//     the school duplicates one to make its own.
//   - A role some login has (archived logins too) can't be deleted.
//   - At least one active login must always hold roles.manage, so the school
//     can't lock itself out of this screen.
//   - Nobody hands out more than they hold: a role's permissions, and the role
//     given to a login, must be within the caller's own permissions; a login
//     whose role holds something the caller doesn't is not the caller's to
//     change. (The Administrator holds everything, so this only limits custom
//     roles that were given users.manage or roles.manage.)
// Changes that touch roles.manage holders run under one advisory lock, so two
// people can't each remove the other's access at the same moment.
import { Op, UniqueConstraintError } from "sequelize";
import sequelize from "../config/database.js";
import { Role, RolePermission, Teacher, UserAccount } from "../models/index.js";
import { AppError } from "../utils/errorHandling.js";
import {
  MODULES,
  P,
  PERMISSIONS,
  SYSTEM_ROLES,
  isPermissionKey,
  permissionsOf,
  systemRoleById,
  systemRoleByName,
} from "../utils/permissions.js";
import { clearAccessCache } from "./officeAccess.js";

const ROLE_LOCK = 50050; // pg_advisory_xact_lock key for role / login-role changes
const NAME_MAX = 50;
const DESCRIPTION_MAX = 200;

const text = (v) => (v == null ? "" : String(v).trim());
const toId = (v, what = "role") => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new AppError(`Choose a valid ${what}.`, 400);
  return n;
};

// ------------------------------------------------------------------ catalogue
export const listPermissions = () => ({
  modules: MODULES.map((m) => ({
    key: m.key,
    label: m.label,
    permissions: PERMISSIONS.filter((p) => p.module === m.key).map(({ key, label }) => ({ key, label })),
  })).filter((m) => m.permissions.length),
});

// ------------------------------------------------------------------ helpers
export const lockRoles = (transaction) => sequelize.query(`SELECT pg_advisory_xact_lock(${ROLE_LOCK})`, { transaction });

const customPermissions = async (roleId, transaction) => {
  const rows = await RolePermission.findAll({ where: { roleId }, attributes: ["permissionKey"], raw: true, transaction });
  return rows.map((r) => r.permissionKey).filter(isPermissionKey).sort();
};

/** A role's permission keys: a system role's from code, a custom one's from its rows. */
const permissionsOfRole = async (role, transaction) => {
  const system = role.isSystem ? systemRoleById(role.roleId) : null;
  if (role.isSystem) return system ? [...system.permissions].sort() : [];
  return customPermissions(role.roleId, transaction);
};

const loadRole = async (roleId, { transaction, lock } = {}) => {
  const role = await Role.findByPk(roleId, { raw: true, transaction, lock });
  if (!role) throw new AppError("Role not found", 404);
  return role;
};

/** The role a login has: its role_id, else the system role its category names. */
const roleIdOfAccount = (account) => account.roleId ?? systemRoleByName(account.category)?.roleId ?? null;

const assertWithinCaller = (keys, actor, message) => {
  const mine = permissionsOf(actor) || new Set();
  const beyond = keys.filter((k) => !mine.has(k));
  if (beyond.length) throw new AppError(message, 403);
};

// Permissions that change which class a login or teacher is linked to.
export const LINKING_PERMISSIONS = [P.USERS_MANAGE, "classes.manage", "staff.edit", "subjects.assign_teachers"];
const PERMISSION_LABEL = Object.fromEntries(PERMISSIONS.map((p) => [p.key, p.label]));

const cleanPermissions = (value) => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new AppError("Permissions must be a list.", 400);
  const keys = [...new Set(value.map((k) => text(k)))];
  const unknown = keys.filter((k) => !isPermissionKey(k));
  if (unknown.length) throw new AppError(`Unknown permission: ${unknown.join(", ")}`, 400);
  // Class scope comes from the class linked to a login's staff record. A role
  // that can change that link (create logins for any staff member, edit
  // classes' teachers, edit staff's classes, set subject teachers) without
  // "Every class" could link itself to another class and take it over.
  const linkers = LINKING_PERMISSIONS.filter((k) => keys.includes(k));
  if (linkers.length && !keys.includes(P.ALL_CLASSES)) {
    throw new AppError(`A role with ${linkers.map((k) => `“${PERMISSION_LABEL[k]}”`).join(", ")} must also have “Every class”.`, 400);
  }
  return keys.sort();
};

const cleanName = (value) => {
  const name = text(value).replace(/\s+/g, " ");
  if (!name) throw new AppError("Give the role a name.", 400);
  if (name.length > NAME_MAX) throw new AppError(`A role name can be at most ${NAME_MAX} characters.`, 400);
  return name;
};

const cleanDescription = (value) => {
  const d = text(value);
  if (d.length > DESCRIPTION_MAX) throw new AppError(`The description can be at most ${DESCRIPTION_MAX} characters.`, 400);
  return d || null;
};

const sameName = (name) =>
  sequelize.where(sequelize.fn("lower", sequelize.fn("btrim", sequelize.col("name"))), name.toLowerCase());

const assertNameFree = async (name, { exceptId = null, transaction } = {}) => {
  if (SYSTEM_ROLES.some((r) => r.name.toLowerCase() === name.toLowerCase() && r.roleId !== exceptId)) {
    throw new AppError(`"${name}" is a built-in role. Choose another name.`, 409);
  }
  const where = exceptId ? { [Op.and]: [sameName(name), { roleId: { [Op.ne]: exceptId } }] } : sameName(name);
  const clash = await Role.findOne({ where, attributes: ["roleId"], raw: true, transaction });
  if (clash) throw new AppError(`There is already a role called "${name}".`, 409);
};

/** Role ids whose holders have roles.manage (system from code, custom from rows). */
const roleIdsHolding = async (key, transaction) => {
  const custom = await RolePermission.findAll({ where: { permissionKey: key }, attributes: ["roleId"], raw: true, transaction });
  const system = SYSTEM_ROLES.filter((r) => r.permissions.includes(key)).map((r) => r.roleId);
  return [...new Set([...system, ...custom.map((r) => r.roleId)])];
};

/**
 * How many active logins would still hold roles.manage, leaving out
 * `exceptUsername` and/or every login on `exceptRoleId`.
 */
const managersLeft = async ({ exceptUsername = null, exceptUsernames = [], exceptRoleId = null, transaction } = {}) => {
  const ids = (await roleIdsHolding(P.ROLES_MANAGE, transaction)).filter((id) => id !== exceptRoleId);
  const systemNames = SYSTEM_ROLES.filter((r) => ids.includes(r.roleId)).map((r) => r.name);
  const holders = [];
  if (ids.length) holders.push({ roleId: { [Op.in]: ids } });
  if (systemNames.length) holders.push({ roleId: null, category: { [Op.in]: systemNames } });
  if (!holders.length) return 0;
  const and = [{ isDeleted: { [Op.not]: true } }, { [Op.or]: holders }];
  if (exceptUsername != null) and.push({ username: { [Op.ne]: exceptUsername } });
  if (exceptUsernames.length) and.push({ username: { [Op.notIn]: exceptUsernames } });
  return UserAccount.count({ where: { [Op.and]: and }, transaction });
};

const LAST_MANAGER =
  "At least one office login must keep “Create and edit roles”. Give that permission to another login's role first.";

const shape = (role, permissions, userCount) => ({
  roleId: role.roleId,
  name: role.name,
  description: role.description ?? null,
  isSystem: !!role.isSystem,
  permissions,
  userCount,
  createdAt: role.createdAt ?? null,
  createdBy: role.createdBy ?? null,
  updatedAt: role.updatedAt ?? null,
  updatedBy: role.updatedBy ?? null,
});

const countUsers = async (transaction) => {
  const rows = await UserAccount.findAll({
    attributes: ["roleId", "category"],
    where: { isDeleted: { [Op.not]: true } },
    raw: true,
    transaction,
  });
  const counts = new Map();
  for (const a of rows) {
    const id = roleIdOfAccount(a);
    if (id != null) counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
};

// ------------------------------------------------------------------ roles
export const listRoles = async () => {
  const rows = await Role.findAll({ order: [["isSystem", "DESC"], ["name", "ASC"]], raw: true });
  // System roles always show (from code if migration 050's seed is missing).
  const byId = new Map(rows.map((r) => [r.roleId, r]));
  for (const s of SYSTEM_ROLES) {
    if (!byId.has(s.roleId)) byId.set(s.roleId, { roleId: s.roleId, name: s.name, description: s.description, isSystem: true });
  }
  const counts = await countUsers();
  const out = [];
  for (const role of byId.values()) out.push(shape(role, await permissionsOfRole(role), counts.get(role.roleId) || 0));
  return out.sort((a, b) => Number(b.isSystem) - Number(a.isSystem) || (a.isSystem ? a.roleId - b.roleId : a.name.localeCompare(b.name)));
};

export const getRole = async (roleId) => {
  const role = await loadRole(toId(roleId));
  const counts = await countUsers();
  return shape(role, await permissionsOfRole(role), counts.get(role.roleId) || 0);
};

export const createRole = async (body = {}, actor) => {
  const name = cleanName(body.name);
  const description = cleanDescription(body.description);
  const permissions = cleanPermissions(body.permissions ?? []);
  assertWithinCaller(permissions, actor, "You can only give a role permissions you have yourself.");
  const by = actor?.username ? String(actor.username) : null;
  try {
    const roleId = await sequelize.transaction(async (transaction) => {
      await lockRoles(transaction);
      await assertNameFree(name, { transaction });
      const role = await Role.create(
        { name, description, isSystem: false, createdBy: by, updatedBy: by, createdAt: new Date(), updatedAt: new Date() },
        { transaction }
      );
      if (permissions.length) {
        await RolePermission.bulkCreate(permissions.map((permissionKey) => ({ roleId: role.roleId, permissionKey })), { transaction });
      }
      return role.roleId;
    });
    return getRole(roleId);
  } catch (e) {
    if (e instanceof UniqueConstraintError) throw new AppError(`There is already a role called "${name}".`, 409);
    throw e;
  }
};

export const updateRole = async (roleId, body = {}, actor) => {
  const id = toId(roleId);
  const name = body.name === undefined ? undefined : cleanName(body.name);
  const description = body.description === undefined ? undefined : cleanDescription(body.description);
  const permissions = cleanPermissions(body.permissions);
  if (permissions) assertWithinCaller(permissions, actor, "You can only give a role permissions you have yourself.");
  const by = actor?.username ? String(actor.username) : null;
  try {
    await sequelize.transaction(async (transaction) => {
      await lockRoles(transaction);
      const role = await loadRole(id, { transaction, lock: transaction.LOCK?.UPDATE });
      if (role.isSystem || systemRoleById(role.roleId)) {
        throw new AppError("Built-in roles can't be changed. Duplicate the role to make your own version.", 400);
      }
      const oldName = role.name;
      const before = await customPermissions(id, transaction);
      assertWithinCaller(before, actor, "This role has permissions you don't have, so you can't change it.");
      if (name !== undefined && name !== oldName) await assertNameFree(name, { exceptId: id, transaction });

      if (permissions && before.includes(P.ROLES_MANAGE) && !permissions.includes(P.ROLES_MANAGE)) {
        if ((await managersLeft({ exceptRoleId: id, transaction })) === 0) throw new AppError(LAST_MANAGER, 409);
      }

      const changes = { updatedBy: by, updatedAt: new Date() };
      if (name !== undefined) changes.name = name;
      if (description !== undefined) changes.description = description;
      await Role.update(changes, { where: { roleId: id }, transaction });
      if (permissions) {
        await RolePermission.destroy({ where: { roleId: id }, transaction });
        if (permissions.length) {
          await RolePermission.bulkCreate(permissions.map((permissionKey) => ({ roleId: id, permissionKey })), { transaction });
        }
      }
      // category is the role's name on every login that has it.
      if (name !== undefined && name !== oldName) {
        await UserAccount.update({ category: name }, { where: { roleId: id }, transaction });
      }
    });
  } catch (e) {
    if (e instanceof UniqueConstraintError) throw new AppError(`There is already a role called "${name}".`, 409);
    throw e;
  } finally {
    clearAccessCache();
  }
  return getRole(id);
};

export const deleteRole = async (roleId, actor) => {
  const id = toId(roleId);
  await sequelize.transaction(async (transaction) => {
    await lockRoles(transaction);
    const role = await loadRole(id, { transaction, lock: transaction.LOCK?.UPDATE });
    if (role.isSystem || systemRoleById(role.roleId)) throw new AppError("Built-in roles can't be deleted.", 400);
    assertWithinCaller(await customPermissions(id, transaction), actor, "This role has permissions you don't have, so you can't delete it.");
    const inUse = await UserAccount.count({ where: { roleId: id }, transaction });
    if (inUse > 0) {
      throw new AppError(
        `${inUse} office login${inUse === 1 ? " has" : "s have"} this role (archived logins count too). Give ${inUse === 1 ? "it" : "them"} another role first.`,
        409
      );
    }
    await RolePermission.destroy({ where: { roleId: id }, transaction });
    await Role.destroy({ where: { roleId: id }, transaction });
  });
  clearAccessCache({ roleId: id });
  return { deleted: 1 };
};

/**
 * Archiving these logins (a staff member's) must leave someone holding
 * roles.manage, or nobody could manage roles again (409).
 */
export const assertManagersRemainWithout = async (accounts, { transaction } = {}) => {
  const active = accounts.filter((a) => !a.isDeleted);
  if (!active.length) return;
  const holders = await roleIdsHolding(P.ROLES_MANAGE, transaction);
  if (!active.some((a) => holders.includes(roleIdOfAccount(a)))) return;
  if ((await managersLeft({ exceptUsernames: active.map((a) => a.username), transaction })) === 0) {
    throw new AppError("This is the last office login that can manage roles. Give another login that permission first.", 409);
  }
};

// ------------------------------------------------------------------ logins
// The built-in Administrator role is never given through the app (as before
// B10: Administrator logins come from the seed script). A school that wants a
// second all-powerful login duplicates the role.
const NOT_GIVEN = new Set([1]);

/** The role (id, name, permissions) a new or changed login gets; checks the caller may give it. */
export const roleToGive = async ({ roleId, category } = {}, actor, { transaction } = {}) => {
  let role = null;
  if (roleId !== undefined && roleId !== null && roleId !== "") {
    const id = toId(roleId);
    const system = systemRoleById(id);
    role = system ? { roleId: system.roleId, name: system.name, isSystem: true } : await Role.findByPk(id, { raw: true, transaction });
    if (!role) throw new AppError("Choose a valid role.", 400);
  } else {
    // Office-login form from before B10: a system role by its exact name.
    const system = systemRoleByName(text(category));
    if (!system) throw new AppError("Choose a valid role.", 400);
    role = { roleId: system.roleId, name: system.name, isSystem: true };
  }
  if (NOT_GIVEN.has(role.roleId)) {
    throw new AppError("The built-in Administrator role is set up by the seed script, not given here. Duplicate it to make a role like it.", 403);
  }
  const permissions = await permissionsOfRole(role, transaction);
  assertWithinCaller(permissions, actor, "You can only give a login a role whose permissions you have yourself.");
  return { roleId: role.roleId, name: role.name, isSystem: !!role.isSystem, permissions };
};

export const listOfficeLogins = async () => {
  const rows = await UserAccount.findAll({
    attributes: ["username", "email", "category", "roleId", "teacherId", "isDeleted"],
    include: [{ model: Teacher, as: "teacher", attributes: ["teacherId", "fName", "lName"], required: false }],
    order: [["username", "ASC"]],
  });
  const roles = new Map((await Role.findAll({ attributes: ["roleId", "name"], raw: true })).map((r) => [r.roleId, r.name]));
  for (const s of SYSTEM_ROLES) if (!roles.has(s.roleId)) roles.set(s.roleId, s.name);
  return rows.map((row) => {
    const a = typeof row.get === "function" ? row.get({ plain: true }) : row;
    const id = roleIdOfAccount(a);
    return {
      username: a.username,
      email: a.email || null,
      teacherId: a.teacherId ?? null,
      staffName: a.teacher ? [a.teacher.fName, a.teacher.lName].filter(Boolean).join(" ") : null,
      roleId: id,
      roleName: id != null ? roles.get(id) ?? null : null,
      archived: !!a.isDeleted,
    };
  });
};

// The permissions of the role a login has (system from code, custom from rows).
const permissionsOfAccount = async (account, transaction) => {
  const id = roleIdOfAccount(account);
  if (id == null) return [];
  const system = systemRoleById(id);
  return system ? [...system.permissions] : customPermissions(id, transaction);
};

/** A login whose role holds something the caller doesn't is not the caller's to change or disable. */
export const assertMayChangeLogin = async (account, actor, { transaction, message } = {}) => {
  assertWithinCaller(
    await permissionsOfAccount(account, transaction),
    actor,
    message || "This login's role has permissions you don't have, so you can't change it."
  );
};

export const setLoginRole = async (username, body = {}, actor) => {
  // The key exactly as given: live logins can carry stray spaces ("Admin "),
  // so a trimmed key would miss them or hit another login.
  const name = username == null ? "" : String(username);
  if (!name.trim()) throw new AppError("Choose a login.", 400);
  await sequelize.transaction(async (transaction) => {
    await lockRoles(transaction);
    const account = await UserAccount.findByPk(name, { attributes: ["username", "roleId", "category", "isDeleted"], raw: true, transaction });
    if (!account) throw new AppError("Office login not found", 404);
    const next = await roleToGive({ roleId: body.roleId }, actor, { transaction });

    const current = await permissionsOfAccount(account, transaction);
    await assertMayChangeLogin(account, actor, { transaction });

    if (!account.isDeleted && current.includes(P.ROLES_MANAGE) && !next.permissions.includes(P.ROLES_MANAGE)) {
      if ((await managersLeft({ exceptUsername: account.username, transaction })) === 0) throw new AppError(LAST_MANAGER, 409);
    }
    await UserAccount.update({ roleId: next.roleId, category: next.name }, { where: { username: account.username }, transaction });
  });
  clearAccessCache({ username: name });
  return (await listOfficeLogins()).find((l) => l.username === name) || null;
};
