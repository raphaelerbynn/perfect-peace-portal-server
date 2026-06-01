import { Op } from "sequelize";
import sequelize from "../config/database.js";
import {
  KgAssessment,
  Student,
  StudentMarks,
  StudentResult,
  Subject,
} from "../models/index.js";
import { AppError } from "../utils/errorHandling.js";
import { getTerm } from "./term.js";

// ---------------------------------------------------------------------------
// Feature #8 — authoritative, non-destructive results engine.
//
// Design (locked decisions):
//  - Every save is an UPSERT keyed by (student, subject, class, termId) for marks
//    and (student, class, termId) for the aggregate — NEVER destroy-then-create,
//    so a partial save can never wipe other subjects' marks. All multi-row writes
//    run inside a single transaction.
//  - The SERVER recomputes every percentage / total / aggregate from the Subject
//    config (examTotalMarks / classTotalMarks / examPercentage / classPercentage /
//    passMarks — Feature #6) and the persisted marks. Client-supplied derived
//    numbers are ignored. Teacher judgement fields (conduct/attitude/interest/
//    remarks/status/promotion) are preserved as entered.
//  - A score of 0 is a VALID score (the old code dropped it as "no data").
// ---------------------------------------------------------------------------

const isBlank = (v) => v === "" || v === null || v === undefined;

const gradeRemark = (mark) => {
  const m = Number(mark);
  if (!Number.isFinite(m)) return "---";
  if (m < 40) return "Fail";
  if (m < 50) return "Pass";
  if (m < 60) return "Credit";
  if (m < 70) return "Good";
  if (m < 80) return "Very Good";
  return "Excellent"; // <= 100
};

// Recompute the per-subject weighted percentages + total from the subject config.
// Authoritative: divides the raw score by the subject's actual total marks (the
// FE wrongly assumed every subject is out of 100).
const computeMarkFields = (subject, classScoreRaw, examScoreRaw) => {
  const classTotal = Number(subject.classTotalMarks);
  const examTotal = Number(subject.examTotalMarks);
  const classPct = Number(subject.classPercentage);
  const examPct = Number(subject.examPercentage);

  if (
    ![classTotal, examTotal, classPct, examPct].every(Number.isFinite) ||
    classTotal <= 0 ||
    examTotal <= 0
  ) {
    throw new AppError(
      `Subject "${subject.name}" is not fully configured (class/exam total marks & percentages). Set them under Subjects before entering results.`,
      409
    );
  }

  const cs = Number(classScoreRaw);
  const es = Number(examScoreRaw);
  if (!Number.isFinite(cs) || !Number.isFinite(es)) {
    throw new AppError("Scores must be numbers", 400);
  }
  if (cs < 0 || es < 0) {
    throw new AppError("Scores cannot be negative", 400);
  }
  if (cs > classTotal) {
    throw new AppError(`Class score for "${subject.name}" cannot exceed ${classTotal}`, 400);
  }
  if (es > examTotal) {
    throw new AppError(`Exam score for "${subject.name}" cannot exceed ${examTotal}`, 400);
  }

  const classScorePercentage = (cs / classTotal) * classPct;
  const examScorePercentage = (es / examTotal) * examPct;
  const totalScore = classScorePercentage + examScorePercentage;

  return {
    classScore: cs,
    examScore: es,
    classScorePercentage: Math.round(classScorePercentage),
    examScorePercentage: Math.round(examScorePercentage),
    totalScore: Math.round(totalScore),
    remarks: gradeRemark(totalScore),
  };
};

// Upsert ONE subject mark (recomputed server-side). Returns the persisted row.
const upsertOneMark = async (data, termId, t) => {
  if (isBlank(data?.classMark) && isBlank(data?.examMark)) {
    return null; // nothing entered for this subject — skip, don't wipe
  }
  if (isBlank(data?.classMark) || isBlank(data?.examMark)) {
    throw new AppError("Both class and exam marks are required for a subject", 400);
  }
  if (data?.subjectId == null) {
    throw new AppError("subjectId is required", 400);
  }

  const subject = await Subject.findOne({
    where: { subjectId: data.subjectId },
    raw: true,
    transaction: t,
  });
  if (!subject) throw new AppError("Subject not found", 404);

  const computed = computeMarkFields(subject, data.classMark, data.examMark);

  const where = {
    studentId: data.studentId,
    subjectId: data.subjectId,
    class: data.class,
    termId,
  };
  const payload = {
    ...where,
    term: data.term,
    examScore: computed.examScore,
    classScore: computed.classScore,
    classScorePercentage: computed.classScorePercentage,
    examScorePercentage: computed.examScorePercentage,
    totalScore: computed.totalScore,
    remarks: computed.remarks,
    date: new Date(),
  };

  const existing = await StudentMarks.findOne({ where, transaction: t });
  if (existing) {
    await StudentMarks.update(payload, {
      where: { studentMarksId: existing.studentMarksId },
      transaction: t,
    });
    return StudentMarks.findByPk(existing.studentMarksId, { transaction: t });
  }
  return StudentMarks.create(payload, { transaction: t });
};

// Recompute (and upsert) the StudentResult aggregate from the persisted marks.
// `observations` (optional) carries the teacher-entered fields; when omitted the
// existing observation fields are preserved.
const recomputeStudentResult = async (scope, observations, t) => {
  const { studentId, class: className, term, termId } = scope;

  const marks = await StudentMarks.findAll({
    where: { studentId, class: className, termId },
    raw: true,
    transaction: t,
  });

  const subjectIds = [...new Set(marks.map((m) => m.subjectId))];
  let passRawScore = 0;
  if (subjectIds.length) {
    const subjects = await Subject.findAll({
      where: { subjectId: { [Op.in]: subjectIds } },
      attributes: ["subjectId", "passMarks"],
      raw: true,
      transaction: t,
    });
    const passMap = new Map(subjects.map((s) => [s.subjectId, Number(s.passMarks) || 0]));
    passRawScore = subjectIds.reduce((sum, sid) => sum + (passMap.get(sid) || 0), 0);
  }

  const rawScore = Math.round(marks.reduce((sum, m) => sum + Number(m.totalScore || 0), 0));
  const totalRawScore = marks.length * 100;
  const classTotal = await Student.count({
    where: { class: className, isDeleted: { [Op.not]: true } },
    transaction: t,
  });

  const numericFields = { rawScore, passRawScore, totalRawScore, classTotal };

  const existing = await StudentResult.findOne({
    where: { studentId, class: className, termId },
    transaction: t,
  });

  if (existing) {
    const update = { ...numericFields };
    if (observations) {
      update.resultStatus = observations.status ?? existing.resultStatus;
      update.promotedTo = observations.promotedTo ?? existing.promotedTo;
      update.conduct = observations.conduct ?? existing.conduct;
      update.attitude = observations.attitude ?? existing.attitude;
      update.interest = observations.interest ?? existing.interest;
      update.teacherRemarks = observations.remarks ?? existing.teacherRemarks;
    }
    await StudentResult.update(update, {
      where: { studentResultId: existing.studentResultId },
      transaction: t,
    });
    return StudentResult.findByPk(existing.studentResultId, { transaction: t });
  }

  return StudentResult.create(
    {
      studentId,
      class: className,
      term,
      termId,
      ...numericFields,
      resultStatus: observations?.status || null,
      promotedTo: observations?.promotedTo || null,
      conduct: observations?.conduct || null,
      attitude: observations?.attitude || null,
      interest: observations?.interest || null,
      teacherRemarks: observations?.remarks || null,
      date: new Date(),
    },
    { transaction: t }
  );
};

const resolveTermId = async (data) => {
  if (data?.termId) return data.termId;
  const activeTerm = await getTerm();
  return activeTerm?.termId;
};

// PRIMARY single-subject save: upsert the mark + recompute the aggregate, atomic.
const upsertMarksResult = async (data) => {
  const termId = await resolveTermId(data);
  return await sequelize.transaction(async (t) => {
    const mark = await upsertOneMark({ ...data, termId }, termId, t);
    await recomputeStudentResult(
      { studentId: data.studentId, class: data.class, term: data.term, termId },
      null,
      t
    );
    return mark;
  });
};

// /add-single-subject-result now routes to the safe upsert (no destroy-recreate).
const createMarksResult = async (data) => upsertMarksResult(data);

// Multi-subject upsert (no observations) — used by the bulk path; never deletes
// subjects that aren't in the payload.
const bulkCreateMarksResult = async (marksData, studentInfo) => {
  const termId = studentInfo?.termId || (await getTerm())?.termId;
  return await sequelize.transaction(async (t) => {
    const saved = [];
    for (const mark of marksData || []) {
      const row = await upsertOneMark(
        {
          ...mark,
          studentId: studentInfo.studentId,
          class: studentInfo.class,
          term: studentInfo.term,
          termId,
        },
        termId,
        t
      );
      if (row) saved.push(row);
    }
    await recomputeStudentResult(
      { studentId: studentInfo.studentId, class: studentInfo.class, term: studentInfo.term, termId },
      null,
      t
    );
    return saved;
  });
};

// Save the teacher-observation fields onto the StudentResult + recompute numerics.
const createResult = async (data) => {
  const termId = await resolveTermId(data);
  return await sequelize.transaction(async (t) => {
    return recomputeStudentResult(
      { studentId: data.studentId, class: data.class, term: data.term, termId },
      {
        status: data.status,
        promotedTo: data.promotedTo,
        conduct: data.conduct,
        attitude: data.attitude,
        interest: data.interest,
        remarks: data.remarks,
      },
      t
    );
  });
};

// Atomic "Save full result": upsert every provided subject mark AND the
// observations in ONE transaction (the safe replacement for /add-result).
const saveResult = async (data) => {
  const termId = await resolveTermId(data);
  return await sequelize.transaction(async (t) => {
    for (const mark of data?.results || []) {
      await upsertOneMark(
        { ...mark, studentId: data.studentId, class: data.class, term: data.term, termId },
        termId,
        t
      );
    }
    return recomputeStudentResult(
      { studentId: data.studentId, class: data.class, term: data.term, termId },
      {
        status: data.status,
        promotedTo: data.promotedTo,
        conduct: data.conduct,
        attitude: data.attitude,
        interest: data.interest,
        remarks: data.remarks,
      },
      t
    );
  });
};

// KG assessment upsert — scoped per (student, termId, class, category, assessment)
// so the parallel per-key saves NEVER wipe each other (the old code destroyed ALL
// of the student's KG rows for the term on every call). 0 scores are valid.
const createKGResult = async (data) => {
  const termId = await resolveTermId(data);
  const category = data?.category ? `${data.category}`.toUpperCase() : null;

  return await sequelize.transaction(async (t) => {
    const where = {
      studentId: data?.studentId,
      class: data?.class,
      termId,
      category,
      assessment: data?.assessment,
    };
    const payload = {
      ...where,
      term: data?.term,
      satisfactory: data?.satisfactory,
      improved: data?.improved,
      needsImprovement: data?.needsImprovement,
      unsatisfactory: data?.unsatisfactory,
      notApplicable: data?.notApplicable,
      date: new Date(),
      classScorePercentage: data?.classScorePercentage ?? null,
      examScorePercentage: data?.examScorePercentage ?? null,
      classScore: data?.classScore,
      examScore: data?.examScore,
      totalScore: data?.totalScore,
      promoted: data?.promoted,
    };

    const existing = await KgAssessment.findOne({ where, transaction: t });
    if (existing) {
      await KgAssessment.update(payload, {
        where: { kgAssessmentId: existing.kgAssessmentId },
        transaction: t,
      });
      return KgAssessment.findByPk(existing.kgAssessmentId, { transaction: t });
    }
    return KgAssessment.create(payload, { transaction: t });
  });
};

// Delete a student's result set for a class+term. Requires the full scope so it
// can't delete more than intended; runs atomically.
const removeResult = async (data) => {
  const termId = await resolveTermId(data);
  if (!data?.studentId || !data?.class || termId == null) {
    throw new AppError("studentId, class and term are required to delete a result", 400);
  }

  return await sequelize.transaction(async (t) => {
    const scope = { studentId: data.studentId, class: data.class, termId };
    const [marks, result, kg] = await Promise.all([
      StudentMarks.destroy({ where: scope, transaction: t }),
      StudentResult.destroy({ where: scope, transaction: t }),
      KgAssessment.destroy({ where: scope, transaction: t }),
    ]);
    return { marks, result, kg };
  });
};

// --------------------------- reads (unchanged shapes) ----------------------

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
  const replacements = [data.class, data.term];
  const results = await sequelize.query(query, {
    type: sequelize.QueryTypes.SELECT,
    replacements,
  });
  return results;
};

const getClassResult = async (data) => {
  const response = await StudentResult.findAll({
    attributes: {
      include: [
        [sequelize.literal("RANK() OVER (ORDER BY raw_score DESC)"), "position"],
      ],
    },
    where: {
      class: data?.class,
      termId: data?.term,
    },
  });
  return response;
};

const getOneStudentKGResult = async (data) => {
  const response = await KgAssessment.findAll({
    where: {
      class: data?.class,
      termId: data?.term,
      studentId: data?.studentId,
    },
    raw: true,
  });
  return response;
};

const getKGResultByClassAndTerm = async (data) => {
  const response = await KgAssessment.findAll({
    where: {
      class: data?.class,
      termId: data?.term,
    },
    raw: true,
  });
  return response;
};

const getOneStudentResult = async (data) => {
  const response = await StudentResult.findAll({
    attributes: {
      include: [
        [sequelize.literal("RANK() OVER (ORDER BY raw_score DESC)"), "position"],
      ],
    },
    where: {
      class: data?.class,
      termId: data?.term,
      studentId: data?.studentId,
    },
  });
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
  const replacements = [data.class, data.term, data.studentId];
  const results = await sequelize.query(query, {
    type: sequelize.QueryTypes.SELECT,
    replacements,
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
    WHERE student_id = :indexNumber
    ORDER BY term_id DESC, class ASC, year DESC, name1 ASC`;

  const results = await sequelize.query(query, {
    replacements: { indexNumber },
    type: sequelize.QueryTypes.SELECT,
  });
  return results;
};

const getNurseryResults = async (indexNumber) => {
  // BE-W11: use MySQL DATE_FORMAT (was MSSQL FORMAT(date,'yyyy'), invalid in MySQL).
  const results = await KgAssessment.findAll({
    where: {
      student_id: indexNumber,
    },
    attributes: {
      include: [[sequelize.literal(`DATE_FORMAT(date, '%Y')`), "formatted_date"]],
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
    WHERE student_id = :indexNumber
    ORDER BY term_id DESC, class ASC, date DESC`;

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
  bulkCreateMarksResult,
  upsertMarksResult,
  saveResult,
};
