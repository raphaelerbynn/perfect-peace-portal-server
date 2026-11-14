import { getClassAttendanceSummary, getClassYearResults } from "../services/yearReports.js";

// B7: class results for a whole year, and class attendance for a term or a
// whole year (Administrator + Class Teacher for own class; the service scopes).
const handle = (fn) => async (req, res, next) => {
  try {
    res.json(await fn(req, res));
  } catch (error) {
    next(error);
  }
};

const fetchClassYearResults = handle((req) => getClassYearResults(req.query, req.user));
const fetchClassAttendanceSummary = handle((req) => getClassAttendanceSummary(req.query, req.user));

export { fetchClassYearResults, fetchClassAttendanceSummary };
