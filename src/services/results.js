import { Op } from "sequelize";
import sequelize from "../config/database.js";
import { KgAssessment, StudentMarks, StudentResult } from "../models/index.js";
import moment from "moment";

const createMarksResult = async (data) => {
  if (data.classMark && data.examMark) {
    //delete existing one first
    // const currentYear = new Date().getFullYear();
    // const startDate = moment(`${currentYear}-01-01`, "YYYY-MM-DD").format();
    // const endDate = moment(`${currentYear}-12-31`, "YYYY-MM-DD").format();

    await StudentMarks.destroy({
      where: {
        studentId: data?.studentId,
        class: data?.class,
        term: data?.term,
        termId: data?.termId
        // date: {
        //   [Op.gte]: startDate,
        //   [Op.lte]: endDate,
        // },
      },
    });

    //add term ids to student marks

    const response = await StudentMarks.create({
      studentId: data?.studentId,
      subjectId: data?.subjectId,
      examScore: data?.examMark,
      classScore: data?.classMark,
      classScorePercentage: data?.classP,
      examScorePercentage: data?.examP,
      totalScore: data?.total,
      remarks: data?.remark,
      class: data?.class,
      term: data?.term,
      termId: data?.termId,
      date: Date.now(),
    });
    return response;
  }

  return "";
};

const createResult = async (data) => {
  // const currentYear = new Date().getFullYear();
  // const startDate = moment(`${currentYear}-01-01`, "YYYY-MM-DD").format();
  // const endDate = moment(`${currentYear}-12-31`, "YYYY-MM-DD").format();

  await StudentResult.destroy({
    where: {
      studentId: data?.studentId,
      class: data?.class,
      term: data?.term,
      termId: data?.termId,
      // date: {
      //   [Op.gte]: startDate,
      //   [Op.lte]: endDate,
      // },
    },
  });

  //add term ids to student results

  const response = await StudentResult.create({
    studentId: data?.studentId, //
    rawScore: data?.rawScore, //
    passRawScore: data?.passRawScore, //
    totalRawScore: data?.totalRawScore, //
    classTotal: data?.classTotal, //
    resultStatus: data?.status, //
    promotedTo: data?.promotedTo, //
    class: data?.class, //
    term: data?.term, //
    termId: data?.termId, //
    conduct: data?.conduct, //
    attitude: data?.attitude, //
    interest: data?.interest, //
    teacherRemarks: data?.remarks, //
    date: Date.now(),
  });

  return response;
};

const createKGResult = async (data) => {
  // const currentYear = new Date().getFullYear();
  // const startDate = moment(`${currentYear}-01-01`, "YYYY-MM-DD").format();
  // const endDate = moment(`${currentYear}-12-31`, "YYYY-MM-DD").format();

  // console.info(data)

  await KgAssessment.destroy({
    where: {
      studentId: data?.studentId,
      class: data?.class,
      term: data?.term,
      termId: data?.termId,
      // date: {
      //   [Op.gte]: startDate,
      //   [Op.lte]: endDate,
      // },
    },
  });

  //add term ids to assessments

  const response = await KgAssessment.create({
    studentId: data?.studentId, //
    assessment: data?.assessment, //
    category: data?.category.toUpperCase(), //
    satisfactory: data?.satisfactory, //
    improved: data?.improved, //
    needsImprovement: data?.needsImprovement, //
    unsatisfactory: data?.unsatisfactory, //
    notApplicable: data?.notApplicable, 
    term: data?.term, //
    termId: data?.termId, //
    class: data?.class, //
    date: Date.now(),
    classScorePercentage: data?.classScorePercentage || null, //
    examScorePercentage: data?.examScorePercentage || null, //
    classScore: data?.classScore, //
    examScore: data?.examScore, //
    totalScore: data?.totalScore, //
    promoted: data?.promoted, //
  });

  return response;
};

const removeResult = async (data) => {
  const response = await Promise.all([
    StudentMarks.destroy({
      where: {
        studentId: data?.studentId,
        class: data?.class,
        term: data?.term,
        termId: data?.termId,
        // date: {
        //   [Op.like]: `%${data?.date}%`,
        // },
      },
    }),
    StudentResult.destroy({
      where: {
        studentId: data?.studentId,
        class: data?.class,
        term: data?.term,
        // date: {
        //   [Op.like]: `%${data?.date}%`,
        // },
        termId: data?.termId,
      },
    }),
    KgAssessment.destroy({
      where: {
        studentId: data?.studentId,
        class: data?.class,
        term: data?.term,
        termId: data?.termId,
      },
    }),
  ]);

  return response;
};



const getClassMarks = async (data) => {
  const query = `
      SELECT
      student_marks_id AS studentMarksId,
      subject_id AS subjectId,
      student_id AS studentId,
      exam_score AS examScore,
      exam_score_percentage AS examScorePercentage,
      class_score AS classScore,
      class_score_percentage AS classScorePercentage,
      total_score AS totalScore,
      class,
      remarks,
      term_id AS termId,
      date,
      (
        SELECT COUNT(*) + 1 
        FROM \`dbo.Student_marks\` s
        WHERE s.class = \`dbo.Student_marks\`.class
          AND s.term = \`dbo.Student_marks\`.term
          AND s.term_id = \`dbo.Student_marks\`.term_id
          AND s.subject_id = \`dbo.Student_marks\`.subject_id 
          AND s.total_score > \`dbo.Student_marks\`.total_score
      ) AS subjectPosition
    FROM
      \`dbo.Student_marks\`
    WHERE
      class = ?
      AND term_id = ?
      `;
      // WHERE
      //   date LIKE CONCAT('%', ?, '%')
      //   AND class = ?
      //   AND term = ?

  const replacements = [data.class, data.term];

  // const response = await sequelize.query(query, { type: sequelize.QueryTypes.SELECT });
  const results = await sequelize.query(query, {
    type: sequelize.QueryTypes.SELECT,
    replacements
  });

  return results;
};

const getClassResult = async (data) => {
  const response = await StudentResult.findAll({
    attributes: {
      include: [
        [
          sequelize.literal("RANK() OVER (ORDER BY raw_score DESC)"),
          "position",
        ],
      ],
    },
    where: {
      class: data?.class,
      termId: data?.term,
      // [Op.and]: [sequelize.literal(`date LIKE '%${data?.year}%'`)],
    },
    // where: {
    //   class: data?.class,
    //   term: data?.term,
    //   [Op.and]: [sequelize.literal(`date LIKE '%${data?.year}%'`)],
    // },
  });

  

  return response;
};

const getOneStudentKGResult = async (data) => {
  const response = await KgAssessment.findAll({
    where: {
      class: data?.class,
      // term: data?.term,
      termId: data?.term,
      // [Op.and]: [sequelize.literal(`date LIKE '%${data?.year}%'`)],
      studentId: data?.studentId,
    },
    raw: true
  });


  return response;
};

const getKGResultByClassAndTerm = async (data) => {
  const response = await KgAssessment.findAll({
    where: {
      class: data?.class,
      // term: data?.term,
      termId: data?.term,
      // [Op.and]: [sequelize.literal(`date LIKE '%${data?.year}%'`)]
    },
    raw: true
  });


  return response;
};

const getOneStudentResult = async (data) => {
  const response = await StudentResult.findAll({
    attributes: {
      include: [
        [
          sequelize.literal("RANK() OVER (ORDER BY raw_score DESC)"),
          "position",
        ],
      ],
    },
    where: {
      class: data?.class,
      // term: data?.term,
      termId: data?.term,
      // [Op.and]: [sequelize.literal(`date LIKE '%${data?.year}%'`)],
      studentId: data?.studentId,
    },
  });

  // console.log(response)

  return response;
};

const getOneStudentMarks = async (data) => {
  const query = `
      SELECT
      student_marks_id AS studentMarksId,
      subject_id AS subjectId,
      student_id AS studentId,
      exam_score AS examScore,
      exam_score_percentage AS examScorePercentage,
      class_score AS classScore,
      class_score_percentage AS classScorePercentage,
      total_score AS totalScore,
      class,
      remarks,
      term,
      term_id AS termId,
      date,
      (
        SELECT COUNT(*) + 1 
        FROM \`dbo.Student_marks\` s
        WHERE s.class = \`dbo.Student_marks\`.class
          AND s.term = \`dbo.Student_marks\`.term
          AND s.term_id = \`dbo.Student_marks\`.term_id
          AND s.subject_id = \`dbo.Student_marks\`.subject_id 
          AND s.total_score > \`dbo.Student_marks\`.total_score
      ) AS subjectPosition
    FROM
      \`dbo.Student_marks\`
    WHERE
      class = ?
      AND term_id = ?
      AND student_id = ?;
  `;

  // const response = await sequelize.query(query, { type: sequelize.QueryTypes.SELECT });
  const replacements = [data.class, data.term, data.studentId];
  // console.log(replacements)

  const results = await sequelize.query(query, {
    type: sequelize.QueryTypes.SELECT,
    replacements
  });

  return results;
};

const getResults = async (indexNumber) => {
  const query = `
    SELECT 
    \`dbo.Subject\`.name AS name1, 
        exam_score_percentage, 
        class_score_percentage, 
        total_score,
        remarks,
        term,
        class,
        DATE_FORMAT(date, '%Y') AS year,
        section,
        (
            SELECT COUNT(*) + 1 
            FROM \`dbo.Student_marks\` s
            WHERE s.class=\`dbo.Student_marks\`.class
            AND s.term=\`dbo.Student_marks\`.term
            AND s.term_id=\`dbo.Student_marks\`.term_id
            AND s.subject_id=\`dbo.Student_marks\`.subject_id 
            AND s.total_score > \`dbo.Student_marks\`.total_score
        ) AS subject_position
    FROM \`dbo.Student_marks\`
    LEFT JOIN \`dbo.Subject\` ON \`dbo.Student_marks\`.subject_id=\`dbo.Subject\`.subject_id 
    LEFT JOIN \`dbo.Class\` ON \`dbo.Student_marks\`.class = \`dbo.Class\`.name
    WHERE student_id = :indexNumber`;

  const results = await sequelize.query(query, {
    replacements: { indexNumber },
    type: sequelize.QueryTypes.SELECT,
  });
  return results;
};

const getNurseryResults = async (indexNumber) => {
  const results = await KgAssessment.findAll({
    where: {
      student_id: indexNumber,
    },
    attributes: {
      include: [[sequelize.literal(`FORMAT(date, 'yyyy')`), "formatted_date"]],
    },
  });

  return results;
};

const getResultDetails = async (indexNumber) => {
  const query = `
    SELECT 
    *,
    (SELECT COUNT(*) + 1 FROM \`dbo.Student_result\` s 
      WHERE s.class = \`dbo.Student_result\`.class
      AND s.term = \`dbo.Student_result\`.term
      AND s.term_id=\`dbo.Student_result\`.term_id
      AND s.raw_score > \`dbo.Student_result\`.raw_score
    ) AS position,
    (SELECT section FROM \`dbo.Class\` c 
      WHERE c.name = \`dbo.Student_result\`.class
    ) AS section
    FROM \`dbo.Student_result\` 
    WHERE student_id = :indexNumber`;

  const results = await sequelize.query(query, {
    replacements: { indexNumber },
    type: sequelize.QueryTypes.SELECT,
  });
  return results;
};

export {
  getResults,
  getNurseryResults,
  getResultDetails,
  getClassResult,
  getClassMarks,
  getOneStudentMarks,
  getOneStudentResult,
  getOneStudentKGResult,
  getKGResultByClassAndTerm,
  createMarksResult,
  createResult,
  createKGResult,
  removeResult,
};
