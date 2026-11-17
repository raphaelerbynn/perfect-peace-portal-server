// B10: what an office (management) login may do, worked out on the server for
// every request. Permissions are never read from the token.
//
//   1. The login's account row (by the token's username): its role_id, else
//      the system role named by its category (tokens signed before B10 carry
//      no roleId; that's fine, the row decides). An archived account
//      (is_deleted) gets nothing, so archiving a staff member ends their
//      session too.
//   2. No account row (a login removed): nothing. The token's roleId and
//      category are never trusted on their own.
//   3. The role's permissions: a system role's from code (utils/permissions.js),
//      a custom role's from Role_permission.
//
// Both lookups are cached for a short time and dropped when a role or a
// login's role changes (clearAccessCache), so a change applies at once in
// this process and within ACCOUNT_TTL_MS / ROLE_TTL_MS (60 s at most) in any
// other API process. A lookup that started before a clear is used for its own
// request but never stored (generation counter), so it can't bring old grants back.
import * as store from "./accessStore.js";
import { isPermissionKey, systemRoleById, systemRoleByName } from "../utils/permissions.js";

const ACCOUNT_TTL_MS = 30 * 1000;
const ROLE_TTL_MS = 60 * 1000;

const accountCache = new Map(); // username -> { at, value }
const roleCache = new Map(); // roleId -> { at, value }
let generation = 0; // bumped by every clearAccessCache

const cached = async (map, key, ttl, load) => {
  const hit = map.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const started = generation;
  const value = await load();
  if (started === generation) map.set(key, { at: Date.now(), value });
  return value;
};

/** Drop cached access: one login, one role, or (no argument) everything. */
export const clearAccessCache = ({ username, roleId } = {}) => {
  generation += 1;
  if (username === undefined && roleId === undefined) {
    accountCache.clear();
    roleCache.clear();
    return;
  }
  if (username !== undefined) accountCache.delete(String(username));
  if (roleId !== undefined) roleCache.delete(Number(roleId));
};

const loadRole = (roleId) =>
  cached(roleCache, Number(roleId), ROLE_TTL_MS, async () => {
    const system = systemRoleById(roleId);
    if (system) return { roleId: system.roleId, name: system.name, isSystem: true, permissions: new Set(system.permissions) };
    const row = await store.findRole(roleId);
    if (!row) return null;
    if (row.isSystem) {
      // Only ids 1-3 are system roles; anything else marked so gets nothing.
      return { roleId: row.roleId, name: row.name, isSystem: true, permissions: new Set() };
    }
    const keys = await store.rolePermissionKeys(row.roleId);
    return { roleId: row.roleId, name: row.name, isSystem: false, permissions: new Set(keys.filter(isPermissionKey)) };
  });

const none = (roleName) => ({ roleId: null, roleName: roleName ?? null, isSystem: false, permissions: new Set() });

/** { roleId, roleName, isSystem, permissions: Set } for a verified management token. */
export const resolveAccess = async (user) => {
  const username = user?.username == null ? "" : String(user.username);
  // (`user` is passed on only for the test stand-in, testSupport/fakeAccessStore.js;
  // the database store reads nothing but the username.)
  const account = username ? await cached(accountCache, username, ACCOUNT_TTL_MS, () => store.findAccount(username, user)) : null;
  if (!account) return none(user?.category);
  if (account.isDeleted) return none(account.category);

  const { roleId, category } = account;
  let role = null;
  if (roleId != null && roleId !== "") {
    role = await loadRole(roleId);
  } else {
    const system = systemRoleByName(category);
    if (system) role = await loadRole(system.roleId);
  }
  if (!role) return none(category);
  return { roleId: role.roleId, roleName: role.name, isSystem: role.isSystem, permissions: role.permissions };
};

/** Put the caller's role and permissions on req.user (a copy of the cached set). */
export const attachOfficeAccess = async (user) => {
  const access = await resolveAccess(user);
  user.roleId = access.roleId;
  user.roleName = access.roleName;
  user.permissions = new Set(access.permissions);
  return user;
};

/** What the admin app is told: role and permission list (sorted). */
export const accessSummary = (user) => ({
  roleId: user?.roleId ?? null,
  roleName: user?.roleName ?? null,
  permissions: [...(user?.permissions || [])].sort(),
});
