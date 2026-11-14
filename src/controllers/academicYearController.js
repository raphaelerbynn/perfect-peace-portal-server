import { createYear, deleteYear, getYear, listYears, setCurrentYear, updateYear } from "../services/academicYear.js";
import { activateTerm, createYearTerm, deleteTerm } from "../services/term.js";

// B7: academic years. Routes in routes/academicYearRoutes.js.
const handle = (fn) => async (req, res, next) => {
  try {
    res.json(await fn(req, res));
  } catch (error) {
    next(error);
  }
};

export const fetchAcademicYears = handle(() => listYears());
export const fetchAcademicYear = handle((req) => getYear(req.params.id));
export const addAcademicYear = handle((req) => createYear(req.body));
export const editAcademicYear = handle((req) => updateYear(req.params.id, req.body));
export const removeAcademicYear = handle((req) => deleteYear(req.params.id));
export const makeAcademicYearCurrent = handle((req) => setCurrentYear(req.params.id));
export const addYearTerm = handle((req) => createYearTerm(req.params.id, req.body));
export const openTerm = handle((req) => activateTerm(req.params.id));
export const removeTerm = handle((req) => deleteTerm(req.params.id));
