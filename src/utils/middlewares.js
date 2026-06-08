import jwt from "jsonwebtoken";
import { JWT_SECRET, JWT_ALGORITHM } from "../config/auth.js";

const undefinedEndpoint = (req, res, next) => {
    const err = new Error("Page requesting not found");
    res.status(404);
    next(err)
}

// Shared factory for token authentication.
// `requireManagement` enforces that the decoded token is management-shaped
// (i.e. carries a `category` claim) so portal (student/teacher) tokens cannot
// be replayed against management endpoints.
const makeAuthenticator = ({ requireManagement = false } = {}) => (req, res, next) => {
    try {
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

        let user;
        try {
            user = jwt.verify(token, JWT_SECRET, { algorithms: [JWT_ALGORITHM] });
        } catch (verifyErr) {
            res.status(401);
            if (verifyErr.name === "TokenExpiredError") {
                throw Error("Token expired");
            }
            throw Error("Invalid token");
        }

        if (requireManagement && !user.category) {
            // BE-3: a portal (student/teacher) token is a VALID token but lacks a
            // `category` claim, so this is an authorization failure (403), not an
            // authentication failure (401). Returning 401 wrongly told portal
            // clients to force a re-login.
            res.status(403);
            throw Error("You do not have permission to perform this action");
        }

        req.user = user;

        next();
    } catch (err) {
        next(err);
    }
};

const authenticateUser = makeAuthenticator();
const authenticateManagementUser = makeAuthenticator({ requireManagement: true });

// Role-based authorization. Must run AFTER an authenticator that populates
// req.user. Returns 403 (not 401) when the authenticated user's category is
// not in the allow-list.
const authorizeRoles = (...allowedCategories) => (req, res, next) => {
    try {
        const category = req.user?.category;
        if (!category || !allowedCategories.includes(category)) {
            res.status(403);
            throw Error("You do not have permission to perform this action");
        }
        next();
    } catch (err) {
        next(err);
    }
};

export {
    authenticateUser,
    undefinedEndpoint,

    authenticateManagementUser,
    authorizeRoles,
}
