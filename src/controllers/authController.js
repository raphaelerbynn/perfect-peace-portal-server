import {
  getManagementUser,
  getStudentUser,
  getTeacherUser,
  signUpManagementUser,
  studentSignUp,
  teacherSignUp,
} from "../services/user.js";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
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

export {
  signin,
  signup,

  //management
  signinManagement,
  signupManagement,
};
