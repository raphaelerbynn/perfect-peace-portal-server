import { StudentMarks, Subject } from "../models/index.js";

const subjects = async () => {
  return await Subject.findAll();
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
