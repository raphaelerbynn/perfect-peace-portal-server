import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { generalRouter } from "./routes/generalRoutes.js";
import { studentRouter } from "./routes/onlyStudentRoutes.js";
import { authRouter } from "./routes/authRoutes.js";
import { fileRouter } from "./routes/fileRoutes.js";
import { errorHandler } from "./utils/errorHandling.js";
import { authenticateManagementUser, authorizeRoles, undefinedEndpoint } from "./utils/middlewares.js";
import dotenv from "dotenv";
import cors from "cors";
import sequelize from "./config/database.js";
import { accountRouter } from "./routes/accountRoutes.js";
import { communicationRouter } from "./routes/communicationRoutes.js";

dotenv.config();
const app = express();

const PORT = process.env.SERVER_PORT || 5050;

// BE-14: auth-sensitive rate limiter. Scoped to signin/signup/OTP/reset routes
// (the authRouter) rather than applied globally, so normal authenticated app
// traffic is not throttled. 20 requests / 10 min / IP is generous for a human
// logging in or resetting a PIN but blocks credential-stuffing / OTP abuse.
const authLimiter = rateLimit({
    windowMs: 10 * 60 * 1000, // 10 minutes
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: "Too many requests from this IP, please try again later." },
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
app.use(AUTH_LIMITED_PATHS, authLimiter);
app.use("/", authRouter);
app.use("/", studentRouter);
app.use("/", fileRouter);

// --- Management (admin portal) routers: token required at mount time ---
// NOTE: the standalone unauthenticated `app.get("/staff", fetchAllStaff)` route
// was removed previously — it leaked all staff records. The authenticated,
// Administrator-only `/staff` route is wired into generalRouter below.
app.use("/", authenticateManagementUser, generalRouter);
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

start();

export default app;
