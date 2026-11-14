import { getClassTermReport, getTermReport, getTermsOverview } from "../services/academicReports.js";

// B11: academic reports (read only). The service scopes Class Teachers.
const handle = (fn) => async (req, res, next) => {
  try {
    res.json(await fn(req));
  } catch (error) {
    next(error);
  }
};

export const fetchTermsOverview = handle(() => getTermsOverview());
export const fetchTermReport = handle((req) => getTermReport(req.params.termId));
export const fetchClassTermReport = handle((req) =>
  getClassTermReport({ termId: req.params.termId, classId: req.params.classId }, req.user)
);
