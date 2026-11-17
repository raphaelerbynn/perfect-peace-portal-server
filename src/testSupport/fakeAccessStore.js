// B10: an in-memory stand-in for services/accessStore.js in every test
// (jestSetup.js). The app trusts only account rows, so by default every
// office token's username "has" a row made from its own claims (roleId,
// category): route tests can keep signing tokens as before. Tests add real
// rows, custom roles and removed logins (removeAccount) with the helpers below.
// Plain functions, not jest.fn(): tests that resetAllMocks() must not wipe them.
const accounts = new Map();
const removed = new Set();
const roles = new Map();
const grants = new Map();

export const findAccount = async (username, claims = null) => {
  const key = String(username);
  if (accounts.has(key)) return accounts.get(key);
  if (removed.has(key) || !claims?.category) return null;
  return { username: key, roleId: claims.roleId ?? null, category: claims.category, isDeleted: false };
};
export const findRole = async (roleId) => roles.get(Number(roleId)) ?? null;
export const rolePermissionKeys = async (roleId) => grants.get(Number(roleId)) ?? [];

export const addRole = ({ roleId, name, permissions = [], isSystem = false }) => {
  roles.set(Number(roleId), { roleId: Number(roleId), name, isSystem });
  grants.set(Number(roleId), [...permissions]);
};
export const addAccount = ({ username, roleId = null, category = null, isDeleted = false }) => {
  accounts.set(String(username), { username: String(username), roleId, category, isDeleted });
};
/** No account row for this username (a login removed from the database). */
export const removeAccount = (username) => {
  accounts.delete(String(username));
  removed.add(String(username));
};
export const reset = () => {
  accounts.clear();
  removed.clear();
  roles.clear();
  grants.clear();
};
