import { bandsForClass, createScale, deleteScale, listScales, updateScale } from "../services/grading.js";

// B8: grading scales. Routes in generalRoutes (management tokens).
const handle = (fn) => async (req, res, next) => {
  try {
    res.json(await fn(req, res));
  } catch (error) {
    next(error);
  }
};

const fetchGradingScales = handle(() => listScales());
const fetchClassGrading = handle((req) => bandsForClass(req.query?.class));
const addGradingScale = handle((req) => createScale(req.body));
const editGradingScale = handle((req) => updateScale(req.params.id, req.body));
const removeGradingScale = handle((req) => deleteScale(req.params.id));

export { fetchGradingScales, fetchClassGrading, addGradingScale, editGradingScale, removeGradingScale };
