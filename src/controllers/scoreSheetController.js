import { getOfficeSheet, saveOfficeSheet } from "../services/scoreSheet.js";

// B6: the office's class score sheet (Upload scores page). Routes in generalRoutes.
const fetchClassSubjectScores = async (req, res, next) => {
  try {
    res.json(await getOfficeSheet(req.user, req.query));
  } catch (error) {
    next(error);
  }
};

const saveClassSubjectScoresSheet = async (req, res, next) => {
  try {
    res.json(await saveOfficeSheet(req.user, req.body || {}));
  } catch (error) {
    next(error);
  }
};

export { fetchClassSubjectScores, saveClassSubjectScoresSheet };
