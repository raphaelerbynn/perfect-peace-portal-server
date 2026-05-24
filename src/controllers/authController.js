import {
  changeManagementUserPassword,
  getManagementUser,
  findManagementUser,
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
  let data;
  try {
    const [role, id] = indexNumber.split("/");
    // console.log(role);
    // console.log(id);
    if (role === "STU") {
      data = await studentSignUp(id, password);
    } else if (role === "STAFF") {
      data = await teacherSignUp(id, password);
    }

    if (data[0] === 0) {
      throw new Error("User already signup");
    }

    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const signin = async (req, res, next) => {
  const { indexNumber, password } = req.body;
  let user;
  try {
    const [role, id] = indexNumber.split("/");
    // console.log(role);
    // console.log(id);
    if (role === "STU") {
      user = await getStudentUser(id, password);
      // console.log(user);
    } else if (role === "STAFF") {
      user = await getTeacherUser(id, password);
    }

    if (!user) {
      res.status(404);
      throw Error("Index nunmber or password");
    }

    const payload = {
      id: id,
      userRole: role,
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: "1d" });
    res.status(200).send({
      token: token,
    });
  } catch (err) {
    console.log(err);
    next(err);
  }
};

//management
const signinManagement = async (req, res, next) => {
  const data = req.body;
  try {
    const user = await getManagementUser(data);
    // console.log(user);

    if (!user) {
      res.status(403);
      throw Error("Incorrect username or password");
    }

    const payload = {
      category: user.category,
      username: user.username,
      teacherId: user.teacherId,
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: "1d" });
    res.status(200).send({
      token: token,
      username: user.username,
      email: user.email,
      category: user.category,
      teacherId: user.teacherId
    });
  } catch (err) {
    console.log(err);
    next(err);
  }
};

const signupManagement = async (req, res, next) => {
  const data = req.body;
  try {
    const user = await findManagementUser(data);

    if (user) {
      res.status(403);
      throw Error(`User already exists as ${data.category}`);
    }

    const result = await signUpManagementUser(data);
    res.status(200).json({message: result});

  } catch (err) {
    console.log(err);
    next(err);
  }
};

const sendStaffPasswordOTP = async (req, res, next) => {
  const userId = req.params.userId;

  try {
    const user = await getTeacherDetails(userId);
    // console.log(user);
    if (user.length < 1) {
      res.status(404);
      throw Error("User not found");
    }
    const teacherContact = user[0]?.phone || "";
    if (!teacherContact) {
      res.status(404);
      throw Error("Contact not found, contact administrator to update your profile");
    }

    const OTP = Math.floor(1000 + Math.random() * 9000);
    const code = OTP.toString().padStart(4, "0");

    const token = jwt.sign({ userId, code }, JWT_SECRET, { expiresIn: '30m' });

    const result = await sendPasswordConfirmationCode(code, teacherContact);
    // console.log(result)
    res.status(200).json({ message: "Password reset code sent to your contact", token });

  } catch (err) {
    console.log(err);
    next(err);
  }
}

const resetForgottenPassword = async (req, res, next) => {
  const { token, code, newPassword } = req.body;
  try {
    let decoded;
    try {
      // jwt.verify enforces token expiry (exp) itself; no manual re-check needed.
      decoded = jwt.verify(token, JWT_SECRET, { algorithms: [JWT_ALGORITHM] });
    } catch (verifyErr) {
      res.status(401);
      if (verifyErr.name === "TokenExpiredError") {
        throw Error("Expired token");
      }
      throw Error("Invalid token");
    }

    if (decoded.code !== code) {
      res.status(403);
      throw Error("Invalid code");
    }

    const user = await getTeacherDetails(decoded.userId);
    if (user.length < 1) {
      res.status(404);
      throw Error("User not found");
    }

    const updateResult = await changeManagementUserPassword(decoded.userId, newPassword);
    if (updateResult[0] === 0) {
      res.status(404);
      throw Error("Error resetting password");
    }
    
    res.status(200).json({ message: "Password reset successful" });
    
  } catch (err) {
    console.log(err);
    next(err);
  }
}

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
