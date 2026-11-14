import { getOneStaffSummary, getStaffDay, getStaffSummary, saveStaffDay } from "../services/staffAttendance.js";

// B9: staff attendance. Routes in routes/staffAttendanceRoutes.js.
const handle = (fn) => async (req, res, next) => {
  try {
    res.json(await fn(req, res));
  } catch (error) {
    next(error);
  }
};

export const fetchStaffDay = handle((req) => getStaffDay(req.query.date));
export const saveStaffAttendance = handle((req) => saveStaffDay(req.body, req.user));
export const fetchStaffSummary = handle((req) => getStaffSummary(req.query));
export const fetchOneStaffSummary = handle((req) => getOneStaffSummary(req.params.teacherId, req.query));
