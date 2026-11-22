// B10: an office caller as the authenticator leaves it on req.user: its
// category plus the permissions of the system role of that name (or `perms`).
import { systemRoleByName } from "../utils/permissions.js";

export const officeUser = (category, extra = {}, perms = null) => ({
  category,
  username: extra.username ?? String(category).toLowerCase().replace(/\s+/g, "."),
  ...extra,
  permissions: new Set(perms ?? systemRoleByName(category)?.permissions ?? []),
});
