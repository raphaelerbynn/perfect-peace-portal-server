import { getClassReportCards, getCompleteness } from "../services/reportCards.js";

// B4: report cards for a whole class (Administrator + Class Teacher for own class).
const handle = (fn) => async (req, res, next) => {
  try {
    res.json(await fn(req, res));
  } catch (error) {
    next(error);
  }
};

const fetchReportCardCompleteness = handle((req) => getCompleteness(req.query, req.user));
const fetchClassReportCards = handle((req) => getClassReportCards(req.query, req.user));

export { fetchReportCardCompleteness, fetchClassReportCards };
