import jwt from "jsonwebtoken";
import { JWT_SECRET, JWT_ALGORITHM } from "../config/auth.js";
import { attachOfficeAccess } from "../services/officeAccess.js";
import { hasAnyPermission, isPermissionKey } from "./permissions.js";

const undefinedEndpoint = (req, res, next) => {
    const err = new Error("Page requesting not found");
    res.status(404);
    next(err)
}

// Shared factory for token authentication.
// `requireManagement` enforces that the decoded token is management-shaped
// (i.e. carries a `category` claim) so portal (student/teacher) tokens cannot
// be replayed against management endpoints. B10: an office token (any
// authenticator) also gets the login's role and permissions on req.user
// (services/officeAccess.js), from the database, never from the token.
const verifyToken = (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        res.status(401);
        throw Error("No authorization header");
    }

    const token = authHeader.split(" ")[1];
    if (!token) {
        res.status(401);
        throw Error("User not authorized");
    }

    try {
        return jwt.verify(token, JWT_SECRET, { algorithms: [JWT_ALGORITHM] });
    } catch (verifyErr) {
        res.status(401);
        if (verifyErr.name === "TokenExpiredError") {
            throw Error("Token expired");
        }
        throw Error("Invalid token");
    }
};

const makeAuthenticator = ({ requireManagement = false } = {}) => async (req, res, next) => {
    try {
        const user = verifyToken(req, res);

        if (requireManagement && !user.category) {
            // BE-3: a portal (student/teacher) token is a VALID token but lacks a
            // `category` claim, so this is an authorization failure (403), not an
            // authentication failure (401). Returning 401 wrongly told portal
            // clients to force a re-login.
            res.status(403);
            throw Error("You do not have permission to perform this action");
        }

        if (user.category) await attachOfficeAccess(user);
        req.user = user;

        next();
    } catch (err) {
        next(err);
    }
};

const authenticateUser = makeAuthenticator();
const authenticateManagementUser = makeAuthenticator({ requireManagement: true });

// B10: permission gate. Must run AFTER authenticateManagementUser (or another
// step that loaded req.user.permissions). Passes when the caller's role holds
// ANY of `keys`; 403 otherwise. Never reads role names.
const requirePermission = (...keys) => {
    if (!keys.length) throw new Error("requirePermission needs at least one permission key");
    const unknown = keys.filter((k) => !isPermissionKey(k));
    if (unknown.length) throw new Error(`Unknown permission key(s): ${unknown.join(", ")}`);
    const gate = (req, res, next) => {
        if (hasAnyPermission(req.user, keys)) return next();
        res.status(403);
        return next(new Error("You do not have permission to perform this action"));
    };
    // Readable by the router-walk access test (testSupport/routeAccess.js).
    gate.permissions = [...keys];
    return gate;
};

export {
    authenticateUser,
    undefinedEndpoint,

    authenticateManagementUser,
    requirePermission,
}
