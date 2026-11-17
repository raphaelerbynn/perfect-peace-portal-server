// B10: an in-memory stand-in for services/accessStore.js in every test
// (jestSetup.js). Empty by default: no account rows, so a token maps to its
// roleId, else to the system role its category names; system roles come from
// code. Tests add custom roles and accounts with the helpers below.
// Plain functions, not jest.fn(): tests that resetAllMocks() must not wipe them.
const accounts = new Map();
const roles = new Map();
const grants = new Map();

export const findAccount = async (username) => accounts.get(String(username)) ?? null;
export const findRole = async (roleId) => roles.get(Number(roleId)) ?? null;
export const rolePermissionKeys = async (roleId) => grants.get(Number(roleId)) ?? [];

export const addRole = ({ roleId, name, permissions = [], isSystem = false }) => {
  roles.set(Number(roleId), { roleId: Number(roleId), name, isSystem });
  grants.set(Number(roleId), [...permissions]);
};
export const addAccount = ({ username, roleId = null, category = null, isDeleted = false }) => {
  accounts.set(String(username), { username: String(username), roleId, category, isDeleted });
};
export const reset = () => {
  accounts.clear();
  roles.clear();
  grants.clear();
};
