import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { generalRouter } from "./routes/generalRoutes.js";
import { studentRouter } from "./routes/onlyStudentRoutes.js";
import { authRouter } from "./routes/authRoutes.js";
import { fileRouter } from "./routes/fileRoutes.js";
import { portalRouter } from "./routes/portalRoutes.js";
import { teacherRouter } from "./routes/teacherRoutes.js";
import { errorHandler } from "./utils/errorHandling.js";
import { authenticateManagementUser, authorizeRoles, undefinedEndpoint } from "./utils/middlewares.js";
import dotenv from "dotenv";
import cors from "cors";
import sequelize from "./config/database.js";
import { accountRouter } from "./routes/accountRoutes.js";
import { communicationRouter } from "./routes/communicationRoutes.js";
import { academicYearRouter } from "./routes/academicYearRoutes.js";
import { feeBillingRouter } from "./routes/feeBillingRoutes.js";
import { mediaRouter } from "./routes/mediaRoutes.js";
import { schoolRouter } from "./routes/schoolRoutes.js";
import { newsRouter } from "./routes/newsRoutes.js";

dotenv.config();
const app = express();

// Behind a reverse proxy (nginx, Apache/Passenger, a load balancer) set
// TRUST_PROXY to the number of proxy hops (usually 1), so req.ip - used by the
// sign-in rate limits - is the real client, not the proxy.
if (process.env.TRUST_PROXY) {
    const hops = Number(process.env.TRUST_PROXY);
    app.set("trust proxy", Number.isFinite(hops) ? hops : process.env.TRUST_PROXY);
}

const PORT = process.env.SERVER_PORT || 5050;

// BE-14: auth-sensitive rate limiter. Scoped to signin/signup/OTP/reset routes
// (the authRouter) rather than applied globally, so normal authenticated app
// traffic is not throttled. 20 requests / 10 min / IP is generous for a human
// logging in or resetting a PIN but blocks credential-stuffing / OTP abuse.
//
// Go-live review: per IP alone, a school computer lab (one NAT address) or any
// reverse proxy (every request comes from the proxy's IP) shares 20 attempts
// between EVERYONE, locking the school out after 20 sign-ins. So:
//   - limit per account (index number / username / phone), 20 per 10 min;
//   - plus a wide per-IP ceiling (TRUST_PROXY makes req.ip the real client).
const accountKey = (req) => {
    const b = req.body || {};
    const who = b.indexNumber ?? b.username ?? b.email ?? b.phone ?? b.contact ?? b.staffId ?? "";
    return `${req.ip}|${String(who).trim().toLowerCase()}`;
};
const authLimiter = rateLimit({
    windowMs: 10 * 60 * 1000, // 10 minutes
    max: 20,
    keyGenerator: accountKey,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: "Too many attempts for this account. Please wait a few minutes and try again." },
});
const authIpCeiling = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: Number(process.env.AUTH_IP_LIMIT) || 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: "Too many sign-in attempts from this network, please try again later." },
});

// BE-13: CORS allowlist driven by env (CORS_ORIGINS, comma-separated). Defaults
// cover local dev (CRA parent app :3000, Vite admin portal :5173) and the
// deployed admin portal so prod keeps working without extra config.
const DEFAULT_CORS_ORIGINS = [
    "http://localhost:3000",   // Perfect-Peace CRA parent/student/teacher app
    "http://localhost:5173",   // perfectpeace-web-school-management Vite dev server
    "http://localhost:4173",   // Vite preview server
    "https://perfectpeace.vercel.app", // deployed admin portal (Vercel)
];
const allowedOrigins = (process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
    : DEFAULT_CORS_ORIGINS);

// Set CORS_ORIGINS="*" to accept ANY origin. We can't return a literal "*"
// header here because credentials:true forbids it, so instead we REFLECT the
// caller's Origin (callback(null, true) does exactly that). Tighten this back to
// a real allowlist before any sensitive production use.
const allowAnyOrigin = allowedOrigins.includes("*");

const corsOptions = {
    origin: (origin, callback) => {
        // Allow non-browser / same-origin requests (curl, server-to-server,
        // health checks) that send no Origin header.
        if (allowAnyOrigin || !origin || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        return callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
};

// BE-14: security headers.
app.use(helmet());
app.use(cors(corsOptions));

// BE-15: explicit body-size limit. The largest legitimate payload is a bulk
// add-result array (capped at MAX_BULK_RESULTS in the controller); 1mb is a
// comfortable ceiling for that JSON while rejecting oversized bodies.
app.use(express.json({ limit: "1mb" }));

app.get("/", async (req, res) => {
  res.send("Welcome to Perfect Peace API");
});

// === Auth boundary (BE-24) ===
// Mounting order below defines the auth boundary explicitly. No route paths are
// renamed/re-prefixed (the frontends depend on them verbatim). Routers are
// ordered so that authenticated routers are NOT shadowed by unauthenticated ones.

// --- Unauthenticated / self-authenticating routers ---
// authRouter: public login/signup/OTP/reset endpoints — rate limited (BE-14).
// studentRouter & fileRouter authenticate per-route internally (portal tokens).
// BE-14 FIX: scope authLimiter to the auth ENDPOINTS only. Mounting it as
// `app.use("/", authLimiter, authRouter)` ran the limiter for EVERY request
// (path "/" matches all), throttling normal authenticated app traffic at
// 20 req/10min/IP — the opposite of the documented intent. Listing the auth
// paths keeps the limiter on signin/signup/OTP/reset while leaving the rest of
// the API unthrottled. (app.use prefix-matches, so "/send-otp" covers
// "/send-otp/:userId".)
const AUTH_LIMITED_PATHS = [
    "/signin",
    "/signup",
    "/signin-management",
    "/signup-management",
    "/signup-staff-list",
    "/send-otp",
    "/reset-password",
    "/get-pin",
    "/update-pin",
    "/verify-pin",
];
app.use(AUTH_LIMITED_PATHS, authIpCeiling, authLimiter); // body already parsed (express.json above)
app.use("/", authRouter);
// B18: GET /school and /school/logo are public; the rest authenticate per route.
app.use("/", schoolRouter);
app.use("/", studentRouter);
app.use("/", fileRouter);
// Portal (STU/STAFF) reads on paths shared with generalRouter. Must be mounted
// BEFORE the management router; management tokens fall through untouched.
app.use("/", portalRouter);
// B15: news feed, polls, events calendar (/posts*, /events?month=), for portal
// AND office tokens; audience-filtered per caller. A plain /events falls through.
app.use("/", newsRouter);
// B2: teacher portal tools (/teacher/*, STAFF tokens only).
app.use("/", teacherRouter);

// --- Management (admin portal) routers: token required at mount time ---
// NOTE: the standalone unauthenticated `app.get("/staff", fetchAllStaff)` route
// was removed previously — it leaked all staff records. The authenticated,
// Administrator-only `/staff` route is wired into generalRouter below.
app.use("/", authenticateManagementUser, generalRouter);
// B7: academic years (reads: all office roles; changes: Administrator).
app.use("/", authenticateManagementUser, academicYearRouter);
// B12: discounts, term billing and statements (roles per route).
app.use("/", authenticateManagementUser, feeBillingRouter);
// B17: pupil / staff photos and documents (office tokens, role + class scoped).
app.use("/", authenticateManagementUser, mediaRouter);
// Accounting/Fees domain: hidden for Class Teacher (Administrator + Accountant only).
app.use("/", authenticateManagementUser, authorizeRoles("Administrator", "Accountant"), accountRouter);

// Messaging (SMS): Administrator only.
app.use("/communication", authenticateManagementUser, authorizeRoles("Administrator"), communicationRouter);

// BE-23: debug routes `/test` (dumped student list unauthenticated) and
// `/requestCount` have been removed.

app.use(undefinedEndpoint);
app.use(errorHandler);

// BE-18: only start serving once the DB connection is verified. On failure,
// log and exit non-zero rather than serving an app that will 500 on every
// data request.
const start = async () => {
  try {
    await sequelize.authenticate();
    console.log("Connection has been established successfully.");

    app.listen(PORT, () =>
      console.log(`📡 server running on port ${PORT}`)
    );
  } catch (err) {
    console.error("Unable to connect to the database. Refusing to start:", err);
    process.exit(1);
  }
};

// Tests import the app without opening a DB connection or a port.
if (process.env.NODE_ENV !== "test") {
  start();
}

export default app;
