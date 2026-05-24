// Application error that explicitly carries an HTTP status code. Prefer throwing
// `new AppError("message", 400)` over the older pattern of mutating
// `res.statusCode` before throwing — it makes the intended status obvious at the
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
//      throwing (this is how the auth layer signals 401/403 — keep compat).
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

    const code = resolveStatusCode(err, res);

    // For client errors (4xx) the message is safe and useful to return.
    // For server errors (5xx) we must NOT leak raw err.message / SQL internals,
    // so we return a generic message and keep the detail in the server logs only.
    let message;
    if (code >= 500) {
        message = "Something went wrong. Please try again later.";
    } else {
        message = err?.message || "Request could not be completed.";
    }

    // Standard envelope: always `{ message }`, never HTTP 200 for an error.
    res.status(code).json({ message });
};


export {
    AppError,
    errorHandler
};
