import {
  changeManagementUserPassword,
  getManagementUser,
  findManagementUser,
  managementUserExistsForStaff,
  getStudentUser,
  getTeacherDetails,
  getTeacherUser,
  signUpManagementUser,
  studentSignUp,
  teacherSignUp,
} from "../services/user.js";
import jwt from "jsonwebtoken";
import { sendPasswordConfirmationCode } from "../services/auth.js";
import { getStaffForSignup } from "../services/staff.js";
import { JWT_SECRET, JWT_ALGORITHM } from "../config/auth.js";
import { issueResetCode, verifyResetCode } from "../services/resetCode.js";
import { AppError } from "../utils/errorHandling.js";
import {
  parseIndexNumber,
  assertRequiredString,
  assertPassword,
  assertEmail,
} from "../utils/validate.js";

// Categories a user is allowed to self-register (BE-A8). Administrator and
// anything else must be provisioned by an existing admin, never self-signup.
const SELF_SIGNUP_CATEGORIES = ["Class Teacher", "Accountant"];

// Discriminator stored alongside the reset code for management accounts.
const MANAGEMENT_USER_TYPE = "MANAGEMENT";

// Public endpoint backing the pre-login signup "Select Staff" picker. Exposes
// only id + name (no PII) — see getStaffForSignup.
const fetchStaffForSignup = async (req, res, next) => {
  try {
    const staff = await getStaffForSignup();
    res.json(staff);
  } catch (error) {
    next(error);
  }
};

const signup = async (req, res, next) => {
  const { indexNumber, password } = req.body;
  try {
    // BE-A6: validate ROLE/ID shape; BE-A10: enforce password min length.
    const { role, id } = parseIndexNumber(indexNumber);
    assertPassword(password);

    // studentSignUp/teacherSignUp set the password only WHERE password IS NULL,
    // so [0] === 0 means either no matching row OR the account is already
    // signed up. BE-A15: don't conflate those internally — but keep the
    // external response non-enumerating with a single generic message.
    const data =
      role === "STU"
        ? await studentSignUp(id, password)
        : await teacherSignUp(id, password);

    if (data[0] === 0) {
      throw new AppError("Unable to complete signup.", 400);
    }

    res.json(data);
  } catch (error) {
    next(error);
  }
};

const signin = async (req, res, next) => {
  const { indexNumber, password } = req.body;
  try {
    // BE-A6: validate ROLE/ID shape instead of throwing a TypeError.
    const { role, id } = parseIndexNumber(indexNumber);

    const user =
      role === "STU"
        ? await getStudentUser(id, password)
        : await getTeacherUser(id, password);

    // BE-A9: uniform, non-enumerating auth failure (same 401 + message as
    // management login).
    if (!user) {
      throw new AppError("Incorrect credentials", 401);
    }

    const payload = {
      id: id,
      userRole: role,
    };

    // BE-A12: pin the algorithm on every jwt.sign.
    const token = jwt.sign(payload, JWT_SECRET, {
      algorithm: JWT_ALGORITHM,
      expiresIn: "1d",
    });
    res.status(200).send({
      token: token,
    });
  } catch (err) {
    next(err);
  }
};

//management
const signinManagement = async (req, res, next) => {
  const data = req.body;
  try {
    // getManagementUser returns a sanitized object (no password hash) — BE-A13.
    const user = await getManagementUser(data);

    // BE-A9: same status (401) + generic message as the portal /signin so the
    // response can't be used to enumerate valid management accounts.
    if (!user) {
      throw new AppError("Incorrect credentials", 401);
    }

    const payload = {
      category: user.category,
      username: user.username,
      teacherId: user.teacherId,
    };

    // BE-A12: pin the algorithm on every jwt.sign.
    const token = jwt.sign(payload, JWT_SECRET, {
      algorithm: JWT_ALGORITHM,
      expiresIn: "1d",
    });
    res.status(200).send({
      token: token,
      username: user.username,
      email: user.email,
      category: user.category,
      teacherId: user.teacherId
    });
  } catch (err) {
    next(err);
  }
};

const signupManagement = async (req, res, next) => {
  const data = req.body;
  try {
    // BE-A10: required-field + type + password-length + email-shape validation.
    assertRequiredString(data?.username, "Username");
    assertRequiredString(data?.staffId, "Staff");
    assertRequiredString(data?.category, "Category");
    assertPassword(data?.password);
    assertEmail(data?.email);

    // BE-A8 (privilege escalation): only the two non-privileged roles may be
    // self-registered. Administrator (or any other value) must be provisioned
    // by an existing admin — never via public self-signup.
    if (!SELF_SIGNUP_CATEGORIES.includes(data.category)) {
      throw new AppError(
        "You are not permitted to self-register for this role.",
        403
      );
    }

    // BE-A15: look the row up first so "already signed up" is handled distinctly
    // from "no such user" internally. The response stays generic.
    const existing = await findManagementUser(data);
    if (existing) {
      throw new AppError("An account already exists for this user.", 409);
    }

    const result = await signUpManagementUser(data);
    res.status(200).json({ message: result });
  } catch (err) {
    next(err);
  }
};

// BE-A1 + BE-A9: admin-portal forgot-password for the MANAGEMENT UserAccount.
// Verifies a management UserAccount exists for the staff id (the Teacher record
// is used ONLY to fetch the phone number). To avoid account enumeration the
// HTTP response is ALWAYS a generic 200 — an SMS is only actually sent when an
// account truly exists and has a contact. The reset code is generated/stored
// via the unified secure store (CSPRNG, bcrypt-hashed, single-use, attempt &
// resend capped) — never embedded in a JWT.
const GENERIC_OTP_MESSAGE =
  "If an account exists, a reset code has been sent.";

const sendStaffPasswordOTP = async (req, res, next) => {
  const staffId = req.params.userId; // route param name kept for compatibility

  try {
    if (!staffId) {
      throw new AppError("Staff id is required.", 400);
    }

    const accountExists = await managementUserExistsForStaff(staffId);

    if (accountExists) {
      const teacher = await getTeacherDetails(staffId);
      const teacherContact = teacher?.[0]?.phone || "";

      if (teacherContact) {
        // issueResetCode enforces the per-user cooldown + daily cap and throws
        // AppError(429) when exceeded — surface that (it is not enumeration,
        // it's abuse protection).
        const code = await issueResetCode({
          identifier: String(staffId),
          userType: MANAGEMENT_USER_TYPE,
        });
        await sendPasswordConfirmationCode(code, teacherContact);
      }
    }

    // Generic response regardless of existence/contact (BE-A9).
    res.status(200).json({ message: GENERIC_OTP_MESSAGE });
  } catch (err) {
    next(err);
  }
};

// BE-A1: new contract — body { staffId, code, password }. No JWT token. The
// code is verified against the unified store (attempts/expiry/single-use) and
// the management UserAccount password is reset with bcrypt.
const resetForgottenPassword = async (req, res, next) => {
  const { staffId, code, password } = req.body;
  try {
    // BE-A10: validate inputs.
    assertRequiredString(staffId, "Staff id");
    assertRequiredString(code, "Reset code");
    assertPassword(password);

    const valid = await verifyResetCode({
      identifier: String(staffId),
      userType: MANAGEMENT_USER_TYPE,
      code,
    });
    if (!valid) {
      throw new AppError("Invalid or expired reset code.", 400);
    }

    const updateResult = await changeManagementUserPassword(staffId, password);
    if (updateResult[0] === 0) {
      throw new AppError("Unable to reset password.", 400);
    }

    res.status(200).json({ message: "Password reset successful" });
  } catch (err) {
    next(err);
  }
};

export {
  signin,
  signup,

  //management
  signinManagement,
  signupManagement,
  sendStaffPasswordOTP,
  resetForgottenPassword,
  fetchStaffForSignup
};
