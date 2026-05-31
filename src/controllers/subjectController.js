import { subjects, createSubject, removeSubject } from "../services/subject.js";
import { AppError } from "../utils/errorHandling.js";

const fetchSubject = async (req, res, next) => {
  try {
    // BE-20: pagination is opt-in via query params; no params => unchanged.
    const { page, limit } = req.query;
    const data = await subjects({ page, limit });
    res.json(data);
  } catch (error) {
    next(error);
  }
};

const addSubject = async (req, res, next) => {
  const values = req.body;
  try {
    const data = await createSubject(values);
    res.json(data);
  } catch (error) {
    next(error);
  }
};

const deleteSubject = async (req, res, next) => {
  const id = req.params.subject_id;
  // BE-U7: reject non-positive-integer ids before hitting the service.
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    return next(new AppError("Invalid subject id", 400));
  }
  try {
    const data = await removeSubject(id);
    res.json(data);
  } catch (error) {
    next(error);
  }
};

export { fetchSubject, addSubject, deleteSubject };
