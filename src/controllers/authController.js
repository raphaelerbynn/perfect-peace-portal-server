import {
  changeManagementUserPassword,
  getManagementUser,
  getStudentUser,
  getTeacherDetails,
  getTeacherUser,
  signUpManagementUser,
  studentSignUp,
  teacherSignUp,
} from "../services/user.js";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { sendPasswordConfirmationCode } from "../services/auth.js";
dotenv.config();

const jwt_secret_key = process.env.JWT_KEY;

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

    const token = await jwt.sign(payload, jwt_secret_key);
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

    const token = await jwt.sign(payload, jwt_secret_key);
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
    const user = await getManagementUser(data);

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

    const token = jwt.sign({ userId, code }, process.env.JWT_KEY, { expiresIn: '30m' });

    const result = await sendPasswordConfirmationCode(code, teacherContact);
    console.log(result)
    res.status(200).json({ message: "Password reset code sent to your contact", token });

  } catch (err) {
    console.log(err);
    next(err);
  }
}

const resetForgottenPassword = async (req, res, next) => {
  const { token, code, newPassword } = req.body;
  try {
    const decoded = jwt.verify(token, process.env.JWT_KEY);
    console.log(decoded)
    if (!decoded) {
      res.status(403);
      throw Error("Invalid token");
    }

    if (decoded.code !== code) {
      res.status(403);
      throw Error("Invalid code");
    }


    const currentTime = Math.floor(Date.now() / 1000);
    if (decoded.exp < currentTime) {
      res.status(403);
      throw Error("Expired token");
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
  resetForgottenPassword
};
