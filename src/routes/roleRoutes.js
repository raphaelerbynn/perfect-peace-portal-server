import { Router } from "express";
import * as roles from "../services/roles.js";
import { accessSummary } from "../services/officeAccess.js";
import { requirePermission } from "../utils/middlewares.js";

// B10: roles and permissions (Settings -> Roles) and each office login's role
// (People -> Office logins). Mounted in src/index.js behind
// authenticateManagementUser, which put the caller's permissions on req.user.
const router = Router();

const send = (fn) => async (req, res, next) => {
  try {
    res.json(await fn(req, res));
  } catch (error) {
    next(error);
  }
};

const ROLES = requirePermission("roles.manage");
const LOGINS = requirePermission("users.manage");
// The office-login form lists the roles too.
const READ_ROLES = requirePermission("roles.manage", "users.manage");

// The caller's own role and permissions (the admin app refreshes its menu
// with it). Any office login; it only ever describes the caller.
router.get("/my-access", send((req) => ({ username: req.user.username ?? null, ...accessSummary(req.user) })));

router.get("/permissions", READ_ROLES, send(() => roles.listPermissions()));
router.get("/roles", READ_ROLES, send(() => roles.listRoles()));
router.get("/roles/:id", READ_ROLES, send((req) => roles.getRole(req.params.id)));
router.post("/roles", ROLES, send((req) => roles.createRole(req.body, req.user)));
router.put("/roles/:id", ROLES, send((req) => roles.updateRole(req.params.id, req.body, req.user)));
router.delete("/roles/:id", ROLES, send((req) => roles.deleteRole(req.params.id, req.user)));

router.get("/office-logins", LOGINS, send(() => roles.listOfficeLogins()));
router.put("/office-logins/:username/role", LOGINS, send((req) => roles.setLoginRole(req.params.username, req.body || {}, req.user)));

export { router as roleRouter };
