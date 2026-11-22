// Application error that explicitly carries an HTTP status code. Prefer throwing
// `new AppError("message", 400)` over the older pattern of mutating
// `res.statusCode` before throwing - it makes the intended status obvious at the
// throw site and survives any later middleware that touches res.
class AppError extends Error {
    constructor(message, statusCode = 500) {
        super(message);
        this.name = "AppError";
        this.statusCode = statusCode;
        // Mark 4xx (except generic 500s) as "safe to expose" to the client.
        this.expose = statusCode >= 400 && statusCode < 500;
    }
}

// Resolve the HTTP status for an error, in priority order:
//   1. An explicit `err.statusCode` (AppError or any error carrying the field).
//   2. A status the upstream middleware set via `res.status(...)` before
//      throwing (this is how the auth layer signals 401/403 - keep compat).
//   3. Fall back to 500.
// Errors must NEVER resolve to a 2xx status.
const resolveStatusCode = (err, res) => {
    const explicit = Number(err?.statusCode);
    if (Number.isInteger(explicit) && explicit >= 400) {
        return explicit;
    }

    const fromRes = Number(res.statusCode);
    if (Number.isInteger(fromRes) && fromRes >= 400) {
        return fromRes;
    }

    return 500;
};

const errorHandler = (err, req, res, next) => {
    // Always log the full error (incl. stack / SQL internals) server-side.
    console.error(err);

    // Two people saving the same thing at the same moment: a unique index
    // refused the second write. Say so instead of a generic 500.
    if (err?.name === "SequelizeUniqueConstraintError") {
        return res.status(409).json({ message: "Someone else saved this at the same moment. Reload and try again." });
    }

    const code = resolveStatusCode(err, res);

    // For client errors (4xx) the message is safe and useful to return.
    // For server errors (5xx) we must NOT leak raw err.message / SQL internals,
    // so we return a generic message and keep the detail in the server logs only.
    // An AppError that sets `expose = true` itself (the AI errors: "the AI
    // service is busy", 503) is written for people, so it is shown as is.
    const exposed = err instanceof AppError && err.expose === true;
    let message;
    if (code >= 500 && !exposed) {
        message = "Something went wrong. Please try again later.";
    } else {
        message = err?.message || "Request could not be completed.";
    }

    // Standard envelope: always `{ message }`, never HTTP 200 for an error.
    // An exposed AppError may add a machine-readable `code` (e.g. AI_QUOTA)
    // and a few `details` fields, so a page can show the right state.
    const body = { message };
    if (exposed && typeof err.code === "string") body.code = err.code;
    if (exposed && err.details && typeof err.details === "object") {
        for (const [k, v] of Object.entries(err.details)) if (!(k in body)) body[k] = v;
    }
    res.status(code).json(body);
};


export {
    AppError,
    errorHandler
};
