import { StudentMarks, Subject } from "../models/index.js";

// BE-20: optional, backward-compatible pagination. No options => identical
// behaviour and shape (full array). limit/offset only applied when supplied.
const subjects = async (options = {}) => {
  const { page, limit } = options;

  const queryOptions = {};
  const parsedLimit = parseInt(limit, 10);
  const parsedPage = parseInt(page, 10);
  if (Number.isInteger(parsedLimit) && parsedLimit > 0) {
    queryOptions.limit = parsedLimit;
    const safePage = Number.isInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
    queryOptions.offset = (safePage - 1) * parsedLimit;
  }

  return await Subject.findAll(queryOptions);
};

const createSubject = async (data) => {
  const response = await Subject.create({
    name: data?.name,
    examTotalMarks: data?.examTotalMarks,
    classTotalMarks: data?.classTotalMarks,
    examPercentage: data?.examPercentage,
    classPercentage: data?.classPercentage,
    passMarks: data?.passMark,
  });

  return response;
};

const removeSubject = async (id) => {
  const response = Promise.all([
    Subject.destroy({
      where: {
        subjectId: id,
      },
    }),
    StudentMarks.destroy({
      where: {
        subjectId: id,
      },
    }),
  ]);

  return response;
};

export { subjects, createSubject, removeSubject };
