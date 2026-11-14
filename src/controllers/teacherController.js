import { notifyAttendanceParents } from "./generalController.js";
import { getMyClasses, getRegister, getScores, saveRegister, saveScores } from "../services/teacherTools.js";
import {
  copyTeachingAssignments,
  listTeachingAssignments,
  removeTeachingAssignment,
  setTeachingAssignment,
} from "../services/teachingAssignment.js";

// B2: teacher portal (STAFF token, req.user.id = teacherId) ------------------

const handle = (fn) => async (req, res, next) => {
  try {
    res.json(await fn(req, res));
  } catch (error) {
    next(error);
  }
};

const teacherId = (req) => Number(req.user?.id);

const fetchMyClasses = handle((req) => getMyClasses(teacherId(req)));
const fetchRegister = handle((req) => getRegister(teacherId(req), req.query));
const fetchScores = handle((req) => getScores(teacherId(req), req.query));
const updateScores = handle((req) => saveScores(teacherId(req), req.body));

const updateRegister = async (req, res, next) => {
  try {
    const { studentAttendance, register } = await saveRegister(teacherId(req), req.body);
    // Parent SMS exactly as the office register does (best-effort).
    await notifyAttendanceParents(studentAttendance, req.body?.date);
    res.json(register);
  } catch (error) {
    next(error);
  }
};

// B2: office (management token, Administrator) -------------------------------

const fetchTeachingAssignments = handle((req) => listTeachingAssignments(req.query));
const upsertTeachingAssignment = handle((req) =>
  setTeachingAssignment(req.body, { createdBy: req.user?.username ?? null })
);
const deleteTeachingAssignment = handle((req) => removeTeachingAssignment(req.params.id));
const copyTermTeachingAssignments = handle((req) =>
  copyTeachingAssignments(req.body, { createdBy: req.user?.username ?? null })
);

export {
  fetchMyClasses,
  fetchRegister,
  updateRegister,
  fetchScores,
  updateScores,
  fetchTeachingAssignments,
  upsertTeachingAssignment,
  deleteTeachingAssignment,
  copyTermTeachingAssignments,
};
