import dotenv from "dotenv";
dotenv.config();

// Single source of truth for the JWT secret used to BOTH sign and verify tokens.
// Fail fast at startup if it is missing so we never silently fall back to a weak
// or hardcoded value.
const JWT_SECRET = process.env.JWT_KEY;

if (!JWT_SECRET) {
  console.error(
    "FATAL: JWT_KEY environment variable is not set. Refusing to start."
  );
  process.exit(1);
}

// Algorithm is pinned wherever we sign/verify to prevent algorithm-confusion attacks.
const JWT_ALGORITHM = "HS256";

export { JWT_SECRET, JWT_ALGORITHM };
