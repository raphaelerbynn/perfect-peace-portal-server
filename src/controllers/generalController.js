import {
  createFeeding,
  createBusFee,
  createExtraClasses,
  getBusFee,
  getExtraClasses,
  getFeeding,
  removeBusFee,
  removeExtraClasses,
  removeFeeding,
} from "../services/account.js";
import {
  markClassAttendance,
  assertClassAccess,
  VALID_STATUSES,
  removeAttendance,
  getAttendance,
  totalAttendanceMarked,
  addTermAttendance,
  getTotalStudentAttendance,
} from "../services/attendance.js";
import {
  createClass,
  createClassFee,
  editClass,
  editClassFee,
  removeClass,
  removeClassFee,
} from "../services/classes.js";
import { createStudentFee, editStudentFee, removeStudentFee } from "../services/studentFees.js";
import {
  createFee,
  getFeesData,
  getOneFee,
  removeFee,
} from "../services/fee.js";
import { sendSMSMessage } from "../services/messaging.js";
import {
  getNews,
  createEvent,
  editEvent,
  removeEvent,
} from "../services/news.js";
import {
  _assignSalary,
  createAllowance,
  createDeduction,
  createSalary,
  createSalaryPayment,
  editSalary,
  getAllowance,
  getDeductions,
  getEmployeeSalary,
  getOneAllowance,
  getOneDeduction,
  getOneSalary,
  getSalary,
  getSalaryPayment,
  removeAllowance,
  removeDeductions,
  removeSalary,
  removeSalaryPayment,
} from "../services/payroll.js";
import {
  getStudentContact,
  getTeacherContact,
  sendResetPin,
  verifyResetPin,
} from "../services/resetPin.js";
import {
  createKGResult,
  createMarksResult,
  createResult,
  getClassMarks,
  getClassResult,
  getOneStudentMarks,
  getOneStudentResult,
  getOneStudentKGResult,
  removeResult,
  getKGResultByClassAndTerm,
  bulkCreateMarksResult,
  upsertMarksResult,
  saveResult,
} from "../services/results.js";
import {
  createStaff,
  editStaff,
  getStaff,
  removeStaff,
} from "../services/staff.js";
import {
  editTerm,
  getTerm,
  setTerm,
  inactivateTerms,
  getTerms,
} from "../services/term.js";
import {
  createStudent,
  editStudent,
  getParentContact,
  getStudents,
  removeStudent,
} from "../services/test.js";
import {
  changeStudentPassword,
  changeTeacherPassword,
  getStudentDetails,
  getTeacherDetails,
} from "../services/user.js";
import { getDashboardSummary, getStudentsOwing } from "../services/dashboard.js";
import { composeMessage, transformReturningKGResult } from "../utils/func.js";
import { absentee_template, present_template } from "../utils/messageTemplates.js";
import { AppError } from "../utils/errorHandling.js";

// BE-15: upper bound on bulk result payloads. A single student's report card
// has at most a few dozen subjects; 200 is a generous ceiling that still rejects
// abusive / malformed oversized arrays with a clear 400.
const MAX_BULK_RESULTS = 200;

// BE-D2: dashboard stat cards. Source for the dashboard's 4 numbers.
const fetchDashboardSummary = async (req, res, next) => {
  try {
    const data = await getDashboardSummary();
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

// BE-D9: students with an outstanding balance, sorted by balance desc.
const fetchStudentsOwing = async (req, res, next) => {
  try {
    const data = await getStudentsOwing();
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

// management
const fetchAllStudents = async (req, res, next) => {
  try {
    // BE-20: pagination/lazy-load are opt-in via query params. With no page/limit
    // the response shape is the plain array (unchanged). BE-S1/BE-S11: search,
    // class/gender/age filtering and Class-Teacher scoping are enforced
    // server-side in getStudents.
    const { page, limit, lite, search, classId, className, gender, minAge, maxAge } = req.query;
    const data = await getStudents({
      page,
      limit,
      lite,
      search,
      classId,
      className,
      gender,
      minAge,
      maxAge,
      // BE-S1: authoritative scoping source — a Class Teacher is constrained to
      // their own class regardless of any client-supplied classId/search.
      requester: {
        role: req.user?.category || req.user?.role,
        teacherId: req.user?.teacherId,
      },
    });
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const fetchAllStaff = async (req, res, next) => {
  try {
    // BE-20: pagination is opt-in via query params; no params => unchanged.
    const { page, limit } = req.query;
    const data = await getStaff({ page, limit });
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const fetchClassMarks = async (req, res, next) => {
  const values = req.query;
  if (!values?.class) {
    return next(new AppError("Missing required parameter: class", 400));
  }
  if (!values?.term) {
    return next(new AppError("Missing required parameter: term", 400));
  }
  try {
    const data = await getClassMarks(values);
    res.json(data);
  } catch (error) {
    next(error);
  }
};

const fetchAttendance = async (req, res, next) => {
  const values = req.query;
  try {
    // BE-5: a Class Teacher may only read their own class's attendance.
    await assertClassAccess(req.user, values.class);
    const data = await getAttendance(values);
    res.json(data);
  } catch (error) {
    next(error);
  }
};

const fetchAttendanceCount = async (req, res, next) => {
  const values = req.query;
  try {
    await assertClassAccess(req.user, values.class);
    const data = await totalAttendanceMarked(values);
    res.json(data);
  } catch (error) {
    next(error);
  }
};

const fetchFees = async (req, res, next) => {
  const values = req.query;
  try {
    const data = await getFeesData(values);
    res.json(data);
  } catch (error) {
    next(error);
  }
};

const fetchOneFee = async (req, res, next) => {
  const id = req.params.fee_id;
  try {
    const data = await getOneFee(id);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const fetchActiveTerm = async (req, res, next) => {
  try {
    const data = await getTerm();
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const fetchTerms = async (req, res, next) => {
  try {
    const data = await getTerms();
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const closeTerm = async (req, res, next) => {
  try {
    const data = await inactivateTerms();
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const fetchClassResult = async (req, res, next) => {
  const values = req.query;
  if (!values?.class) {
    return next(new AppError("Missing required parameter: class", 400));
  }
  if (!values?.term) {
    return next(new AppError("Missing required parameter: term", 400));
  }
  try {
    const results = await getClassResult(values);
    // console.log(results);
    const marks = await getClassMarks(values);
    // console.log(marks)
    

    const data = results.map((result) => {
      const { studentId } = result.dataValues;
      const studentMarks = marks.filter((mark) => {
        if (mark.studentId === studentId) {
          return mark;
        }
      });

      return {
        ...result.dataValues,
        marks: studentMarks,
      };
    });

    res.json(data);
  } catch (error) {
    next(error);
  }
};

const fetchClassKGResult = async (req, res, next) => {
  const values = req.query;
  if (!values?.class) {
    return next(new AppError("Missing required parameter: class", 400));
  }
  if (!values?.term) {
    return next(new AppError("Missing required parameter: term", 400));
  }
  try {
    const data = await getKGResultByClassAndTerm(values);

    const results = data.reduce((acc, item) => {
      const { studentId } = item;

      if (!acc[studentId]) {
        acc[studentId] = {
          studentId,
          promoted: item.promoted,
          class: item.class,
          term: item.term,
          result: [],
        };
      }

      acc[studentId].result.push(item);
      return acc;
    }, {});

    res.json(Object.values(results));
  } catch (error) {
    next(error);
  }
};

const fetchOneKGStudentResult = async (req, res, next) => {
  const values = req.query;
  if (!values?.class) {
    return next(new AppError("Missing required parameter: class", 400));
  }
  if (!values?.term) {
    return next(new AppError("Missing required parameter: term", 400));
  }
  if (!values?.studentId) {
    return next(new AppError("Missing required parameter: studentId", 400));
  }
  try {
    const result = await getOneStudentKGResult(values);
    const formattedData = transformReturningKGResult(result);
    res.json(formattedData);
  } catch (error) {
    next(error);
  }
};

const fetchOneStudentResult = async (req, res, next) => {
  const values = req.query;
  if (!values?.class) {
    return next(new AppError("Missing required parameter: class", 400));
  }
  if (!values?.term) {
    return next(new AppError("Missing required parameter: term", 400));
  }
  if (!values?.studentId) {
    return next(new AppError("Missing required parameter: studentId", 400));
  }
  try {
    const result = await getOneStudentResult(values);
    const marks = await getOneStudentMarks(values);

    res.json({
      ...result[0]?.dataValues,
      marks: marks,
    });
  } catch (error) {
    next(error);
  }
};

const fetchFeeding = async (req, res, next) => {
  const values = req.query;
  try {
    const data = await getFeeding(values);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const fetchExtraClasses = async (req, res, next) => {
  const values = req.query;
  try {
    const data = await getExtraClasses(values);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const fetchBusFee = async (req, res, next) => {
  const values = req.query;
  try {
    const data = await getBusFee(values);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const fetchSalary = async (req, res, next) => {
  try {
    const salaries = await getSalary();

    const data = await Promise.all(
      salaries?.map(async (salary, index) => {
        let amount = salary?.dataValues?.amount;
        let totalAmountWithAllowance = 0;
        let netAmount = 0;

        const allowancesData = await getAllowance(
          salary?.dataValues?.salaryId || salary?.salaryId
        );
        const allowances = allowancesData
          ? allowancesData.reduce(
              (acc, curr) => acc + Number(curr.dataValues.amount),
              0
            )
          : 0;

        const deductionsData = await getDeductions(
          salary?.dataValues?.salaryId || salary?.salaryId
        );
        const deductions = deductionsData
          ? deductionsData.reduce(
              (acc, curr) => acc + Number(curr.dataValues.amount),
              0
            )
          : 0;

        totalAmountWithAllowance = Number(amount) + Number(allowances);
        netAmount = totalAmountWithAllowance - Number(deductions);
        return {
          ...salary.dataValues,
          netAmount: netAmount,
          grossAmount: amount,
          allowances: allowancesData,
          deductions: deductionsData,
        };
      })
    );
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

//dont use
const fetchDeductions = async (req, res, next) => {
  try {
    const data = await getDeductions();
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

//dont use
const fetchAllowances = async (req, res, next) => {
  try {
    const data = await getAllowance();
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const fetchOneSalary = async (req, res, next) => {
  const id = req.params.salary_id;
  try {
    const salary = await getOneSalary(id);
    const deductions = await getOneDeduction(id);
    const allowances = await getOneAllowance(id);

    const data = {
      salary,
      deductions,
      allowances,
    };
    res.json(data);
  } catch (error) {
    next(error);
  }
};

const fetchSalaryPayment = async (req, res, next) => {
  const values = req.query;
  try {
    //sample  values
    // const values = {
    //   dateStart: '2022-09-26',
    //   dateEnd: '2023-02-01',
    //   all: false,
    //   term: ""
    // }
    const data = await getSalaryPayment(values);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const fetchEmployeeSalary = async (req, res, next) => {
  try {
    const data = await getEmployeeSalary();
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const fetchTotalStudentAttendance = async (req, res, next) => {
  const values = req.query;
  try {
    const data = await getTotalStudentAttendance({
      studentId: values.studentId,
      termId: values.termId,
    });
    res.json(data);
  } catch (error) {
    next(error);
  }
};

const addStudent = async (req, res, next) => {
  const values = req.body;
  try {
    const data = await createStudent(values);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const addStaff = async (req, res, next) => {
  const values = req.body;
  // console.log(values);
  try {
    const data = await createStaff(values);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const addClass = async (req, res, next) => {
  const values = req.body;
  // console.log(values);
  try {
    const data = await createClass(values);
    res.json(data);
  } catch (error) {
    next(error);
  }
};

const addStudentFee = async (req, res, next) => {
  const values = req.body;
  try {
    const data = await createStudentFee(values);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const updateStudentFee = async (req, res, next) => {
  const values = req.body;
  const id = req.params.student_fee_id;
  try {
    const data = await editStudentFee(values, id);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};


const addEvent = async (req, res, next) => {
  const values = req.body;
  try {
    const data = await createEvent(values);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const addTerm = async (req, res, next) => {
  const values = req.body;
  try {
    const data = await setTerm(values);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const addClassFee = async (req, res, next) => {
  const values = req.body;
  // console.log("Data::", values);
  try {
    const data = await createClassFee(values);
    res.json(data);
  } catch (error) {
    next(error);
  }
};

const addFee = async (req, res, next) => {
  const values = req.body;
  try {
    const data = await createFee(values);

    // BE-3: confirmation SMS uses the SERVER-computed balance (data.owing),
    // not the forgeable/stale client-supplied `values.remaining`. SMS failure
    // must not fail an already-committed payment.
    try {
      const parentSystemContact = await getParentContact(values?.studentId);
      if (!parentSystemContact.includes(values?.contact) && values?.contact) {
        parentSystemContact.push(values?.contact);
      }
      await sendSMSMessage(
        `Hello, we have received your payment of GHc${data.paid} for ${values.studentName} via ${values.paymentMode}. Balance left for your ward is GHc${data.owing}. Fee ID #${data.feeId}. Thank you! - Perfect Peace`,
        parentSystemContact
      );
    } catch (smsError) {
      // payment is saved; notification is non-critical
    }

    res.json(data);
  } catch (error) {
    next(error);
  }
};

const addSalary = async (req, res, next) => {
  const values = req.body;
  const deductions = values?.deductions || [];
  const allowances = values?.allowances || [];
  // console.log(values);
  try {
    const salary = await createSalary(values);
    const deductionPromises = deductions?.map((deduction) => {
      const newDeduction = {
        ...deduction,
        salaryId: salary.salaryId,
      };
      return createDeduction(newDeduction);
    });
    const allowancePromises = allowances?.map((allowance) => {
      const newAllowance = {
        ...allowance,
        salaryId: salary.salaryId,
      };
      return createAllowance(newAllowance);
    });

    await Promise.allSettled([
      ...deductionPromises,
      ...allowancePromises,
    ]);

    res.json({ 
      ...(salary?.dataValues || salary), 
      grossAmount: values?.amount,
      netAmount: Number(values?.amount) + allowances?.reduce((acc, cur) => acc + Number(cur.amount), 0) - deductions?.reduce((acc, cur) => acc + Number(cur.amount), 0),
      allowances: allowances, 
      deductions: deductions 
    });
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const addResult = async (req, res, next) => {
  const values = req.body;
  const marksData = values?.results;
  try {
    // BE-15: validate the bulk array before doing any DB work.
    if (!Array.isArray(marksData)) {
      throw new AppError("`results` must be an array", 400);
    }
    if (marksData.length > MAX_BULK_RESULTS) {
      throw new AppError(
        `Too many results in a single request (max ${MAX_BULK_RESULTS})`,
        400
      );
    }

    // BE-W2: marks + observations are saved in ONE transaction (saveResult),
    // as non-destructive upserts — a partial submit never wipes other subjects.
    const result = await saveResult(values);

    res.json(result);
  } catch (error) {
    next(error);
  }
};

const addKGResult = async (req, res, next) => {
  const values = req.body;
  const languageDevelopmentData = values?.languageDevelopment;
  const personalDevelopmentData = values?.personalDevelopment;
  const physicalDevelopmentData = values?.physicalDevelopment;
  const cognitiveDevelopmentData = values?.cognitiveDevelopment;
  const academicProgressData = values?.academicProgress;

  try {
    // BE-W7: validate identifiers + every assessment section before iterating
    // (a missing section previously threw "Cannot convert undefined to object").
    if (!values?.studentId || !values?.class) {
      throw new AppError("studentId and class are required", 400);
    }
    const sections = {
      languageDevelopment: languageDevelopmentData,
      personalDevelopment: personalDevelopmentData,
      physicalDevelopment: physicalDevelopmentData,
      cognitiveDevelopment: cognitiveDevelopmentData,
      academicProgress: academicProgressData,
    };
    for (const [label, section] of Object.entries(sections)) {
      if (!section || typeof section !== "object") {
        throw new AppError(`Missing or invalid KG section: ${label}`, 400);
      }
    }

    const languageDevelopmentPromises = Object.entries(
      languageDevelopmentData
    ).map(([key, value]) =>
      createKGResult({
        assessment: key,
        category: "Language Development (Reading, Listening and Oral Skills)",
        satisfactory: value === "satisfactory" ? 1 : 0, //
        improved: value === "improved" ? 1 : 0,
        needsImprovement: value === "needs_improvement" ? 1 : 0,
        unsatisfactory: value === "unsatisfactory" ? 1 : 0,
        notApplicable: value === "not_applicable" ? 1 : 0,
        class: values.class,
        term: values.term,
        termId: values.termId,
        studentId: values.studentId,
        promoted: values.promotedTo,
      })
    );
    const personalDevelopmentPromises = Object.entries(
      personalDevelopmentData
    ).map(([key, value]) =>
      createKGResult({
        assessment: key,
        category: "Personal / Social / Emotional Development",
        satisfactory: value === "satisfactory" ? 1 : 0, //
        improved: value === "improved" ? 1 : 0,
        needsImprovement: value === "needs_improvement" ? 1 : 0,
        unsatisfactory: value === "unsatisfactory" ? 1 : 0,
        notApplicable: value === "not_applicable" ? 1 : 0,
        class: values.class,
        term: values.term,
        termId: values.termId,
        studentId: values.studentId,
        promoted: values.promotedTo,
      })
    );
    const physicalDevelopmentPromises = Object.entries(
      physicalDevelopmentData
    ).map(([key, value]) =>
      createKGResult({
        assessment: key,
        category: "Physical Development",
        satisfactory: value === "satisfactory" ? 1 : 0, //
        improved: value === "improved" ? 1 : 0,
        needsImprovement: value === "needs_improvement" ? 1 : 0,
        unsatisfactory: value === "unsatisfactory" ? 1 : 0,
        notApplicable: value === "not_applicable" ? 1 : 0,
        class: values.class,
        term: values.term,
        termId: values.termId,
        studentId: values.studentId,
        promoted: values.promotedTo,
      })
    );
    const cognitiveDevelopmentPromises = Object.entries(
      cognitiveDevelopmentData
    ).map(([key, value]) =>
      createKGResult({
        assessment: key,
        category: "Cognitive Development (Position, Direction, Thinking)",
        satisfactory: value === "satisfactory" ? 1 : 0, //
        improved: value === "improved" ? 1 : 0,
        needsImprovement: value === "needs_improvement" ? 1 : 0,
        unsatisfactory: value === "unsatisfactory" ? 1 : 0,
        notApplicable: value === "not_applicable" ? 1 : 0,
        class: values.class,
        term: values.term,
        termId: values.termId,
        studentId: values.studentId,
        promoted: values.promotedTo,
      })
    );
    const academicProgressPromises = Object.entries(academicProgressData).map(
      ([key, value]) =>
        createKGResult({
          assessment: key,
          category: "Academic Progress/Examination Scores",
          classScorePercentage: value?.classP, //
          examScorePercentage: value?.examP, //
          classScore: value?.classScore, //
          examScore: value?.examScore, //
          totalScore: value?.totalScore,
          class: values.class,
          term: values.term,
          termId: values.termId,
          studentId: values.studentId,
          promoted: values.promotedTo,
        })
    );
    const results = await Promise.all([
      ...languageDevelopmentPromises,
      ...personalDevelopmentPromises,
      ...physicalDevelopmentPromises,
      ...cognitiveDevelopmentPromises,
      ...academicProgressPromises,
    ]);

    // results.forEach((result) => {
    //   if (result.status === 'rejected') {
    //     console.error(result.reason);
    //   }
    // });

    res.json(results);
  } catch (error) {
    next(error);
  }
};

const addSalaryPayment = async (req, res, next) => {
  const values = req.body;
  // console.log(values);
  try {
    const data = await createSalaryPayment(values);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const addFeeding = async (req, res, next) => {
  const values = req.body;
  // console.log(values);
  try {
    const data = await createFeeding(values);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const addBusFee = async (req, res, next) => {
  const values = req.body;
  // console.log(values);
  try {
    const data = await createBusFee(values);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const addExtraClasses = async (req, res, next) => {
  const values = req.body;
  // console.log(values);
  try {
    const data = await createExtraClasses(values);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const markAttendance = async (req, res, next) => {
  const values = req.body;

  try {
    // BE-7: validate the payload before touching the DB.
    if (!values.class || !values.dateMarked) {
      throw new AppError("class and dateMarked are required", 400);
    }
    if (!Array.isArray(values.studentAttendance) || values.studentAttendance.length === 0) {
      throw new AppError("studentAttendance must be a non-empty array", 400);
    }
    for (const mark of values.studentAttendance) {
      if (mark?.studentId == null) {
        throw new AppError("Each attendance entry requires a studentId", 400);
      }
      if (!VALID_STATUSES.includes(mark.status)) {
        throw new AppError(
          `Invalid status "${mark.status}". Allowed: ${VALID_STATUSES.join(", ")}`,
          400
        );
      }
    }

    // BE-5: a Class Teacher may only mark their own class.
    await assertClassAccess(req.user, values.class);

    // BE-1/BE-2: atomic delete-then-upsert inside markClassAttendance.
    const results = await markClassAttendance({
      className: values.class,
      dateMarked: values.dateMarked,
      studentAttendance: values.studentAttendance,
    });

    // Notify parents (best-effort; SMS failures must not fail the mark since
    // attendance is already committed). Capped at 5 per request, as before.
    try {
      const parentPromiseResults = await Promise.all(
        values.studentAttendance.map((mark) =>
          getParentContact(mark.studentId, true, mark.status)
        )
      );
      const parentContacts = parentPromiseResults.filter((data) => data?.contact);
      await Promise.all(
        parentContacts.slice(0, 5).map((data) =>
          sendSMSMessage(
            composeMessage(
              data,
              String(data.status).toLowerCase() === "present"
                ? present_template
                : absentee_template
            ),
            [data.contact]
          )
        )
      );
    } catch (smsError) {
      // swallow: attendance is saved; notification is non-critical
    }

    res.json(results);
  } catch (error) {
    next(error);
  }
};

const calculateTotalAttendance = async (req, res, next) => {
  try {
    const totalAttendance = await addTermAttendance();
    res.json(totalAttendance);
  } catch (error) {
    next(error);
  }
};

const assignSalary = async (req, res, next) => {
  const values = req.body;
  try {
    const data = await _assignSalary(values);
    res.json(data);
  } catch (error) {
    next(error);
  }
};

const updateStudent = async (req, res, next) => {
  const values = req.body;
  const student_id = req.params.student_id;

  try {
    const data = await editStudent(values, student_id);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const updateStaff = async (req, res, next) => {
  const values = req.body;
  const teacher_id = req.params.teacher_id;

  try {
    const data = await editStaff(values, teacher_id);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const updateClass = async (req, res, next) => {
  const values = req.body;
  const id = req.params.class_id;

  if (!Number.isInteger(Number(id)) || Number(id) <= 0) {
    return next(new AppError("Invalid id", 400));
  }

  try {
    const data = await editClass(values, id);
    res.json(data);
  } catch (error) {
    next(error);
  }
};

const updateClassFee = async (req, res, next) => {
  const values = req.body;
  const id = req.params.class_fee_id;

  if (!Number.isInteger(Number(id)) || Number(id) <= 0) {
    return next(new AppError("Invalid id", 400));
  }

  try {
    const data = await editClassFee(values, id);
    res.json(data);
  } catch (error) {
    next(error);
  }
};

const updateEvent = async (req, res, next) => {
  const values = req.body;
  const id = req.params.news_id;

  try {
    const data = await editEvent(values, id);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const updateTerm = async (req, res, next) => {
  const values = req.body;
  const id = req.params.term_id;

  try {
    const data = await editTerm(values, id);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const updateSalary = async (req, res, next) => {
  const values = req.body;
  const deductions = values?.deductions || [];
  const allowances = values?.allowances || [];

  const id = req.params.salary_id;

  try {
    await editSalary(values, id);

    await Promise.allSettled([removeDeductions(id), removeAllowance(id)]);

    const deductionPromises = deductions?.map((deduction) => {
      const newDeduction = {
        ...deduction,
        salaryId: id,
      };
      return createDeduction(newDeduction);
    });
    const allowancePromises = allowances?.map((allowance) => {
      const newAllowance = {
        ...allowance,
        salaryId: id,
      };
      return createAllowance(newAllowance);
    });

    await Promise.allSettled([
      ...deductionPromises,
      ...allowancePromises,
    ]);
    res.json({ 
      ...values, 
      grossAmount: values?.amount,
      netAmount: Number(values?.amount) + allowances?.reduce((acc, cur) => acc + Number(cur.amount), 0) - deductions?.reduce((acc, cur) => acc + Number(cur.amount), 0),
      allowances: allowances, 
      deductions: deductions 
    });
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const deleteStudent = async (req, res, next) => {
  const student_id = req.params.student_id;

  try {
    const data = await removeStudent(student_id);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const deleteStaff = async (req, res, next) => {
  const teacher_id = req.params.teacher_id;

  try {
    const data = await removeStaff(teacher_id);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const deleteResult = async (req, res, next) => {
  const info = req.query;
  const values = {
    studentId: info?.student_id,
    class: info?.class,
    term: info?.term,
    date: info?.date,
    termId: info?.termId,
  };

  try {
    const data = await removeResult(values);
    res.json(data);
  } catch (error) {
    next(error);
  }
};

const deleteFee = async (req, res, next) => {
  const id = req.params.fee_id;
  try {
    const data = await removeFee(id);
    res.json(data);
  } catch (error) {
    next(error);
  }
};

const deleteEvent = async (req, res, next) => {
  const id = req.params.news_id;
  try {
    const data = await removeEvent(id);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const deleteSalary = async (req, res, next) => {
  const id = req.params.salary_id;
  try {
    const data = await Promise.allSettled([
      removeDeductions(id),
      removeAllowance(id),
      removeSalary(id),
    ]);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const deleteSalaryPayment = async (req, res, next) => {
  const id = req.params.payment_id;
  try {
    const data = await removeSalaryPayment(id);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const deleteClass = async (req, res, next) => {
  const id = req.params.class_id;

  if (!Number.isInteger(Number(id)) || Number(id) <= 0) {
    return next(new AppError("Invalid id", 400));
  }

  try {
    const data = await removeClass(id);
    res.json(data);
  } catch (error) {
    next(error);
  }
};

const deleteClassFee = async (req, res, next) => {
  const id = req.params.class_fee_id;

  if (!Number.isInteger(Number(id)) || Number(id) <= 0) {
    return next(new AppError("Invalid id", 400));
  }

  try {
    const data = await removeClassFee(id);
    res.json(data);
  } catch (error) {
    next(error);
  }
};

const deleteStudentFee = async (req, res, next) => {
  const id = req.params.student_fee_id;
  try {
    const data = await removeStudentFee(id);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const deleteFeeding = async (req, res, next) => {
  const id = req.params.feeding_id;
  try {
    const data = await removeFeeding(id);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const deleteExtraClasses = async (req, res, next) => {
  const id = req.params.extraclasses_id;
  try {
    const data = await removeExtraClasses(id);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const deleteBusFee = async (req, res, next) => {
  const id = req.params.busfee_id;
  try {
    const data = await removeBusFee(id);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const deleteAttendance = async (req, res, next) => {
  const values = req.body;
  try {
    // BE-5: a Class Teacher may only clear their own class's attendance.
    await assertClassAccess(req.user, values.class);
    // BE-8: removeAttendance now hard-requires class + dateMarked (a missing
    // dateMarked used to wipe the whole class across every date).
    const data = await removeAttendance(values);
    res.json(data);
  } catch (error) {
    next(error);
  }
};

//portal
const fetchNews = async (req, res, next) => {
  try {
    // BE-20: pagination is opt-in via query params; no params => unchanged.
    const { page, limit } = req.query;
    const data = await getNews({ page, limit });
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const fetchUserDetails = async (req, res, next) => {
  const { userRole, id } = req.user;

  try {
    if (!userRole) {
      throw new Error("Not loggedn");
    }

    if (userRole === "STAFF") {
      const data = await getTeacherDetails(id);
      res.json(data);
    } else {
      const data = await getStudentDetails(id);
      res.json(data);
    }
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const resetPin = async (req, res, next) => {
  
  const { userRole, id } = req.body;
  let contact = "";

  try {
    if (!userRole) {
      throw new Error("Invalid index number");
    }

    if (userRole === "STAFF") {
      contact = await getTeacherContact(id);
    } else {
      contact = await getStudentContact(id);
    }
    if (!contact) {
      throw new Error("No contact found");
    }
    const data = await sendResetPin([contact], `${userRole}/${id}`);

    res.json({
      sent: data,
      status: "success"
    });
  } catch (error) {
    next(error);
  }
};

const verifyPin = async (req, res, next) => {
  const { indexNumber, pin } = req.body;
  try {
    // Non-destructive peek so the subsequent /update-pin call can still verify
    // + consume the same code (parent-app two-step flow). Response shape is
    // unchanged: { valid: boolean }.
    const data = await verifyResetPin(indexNumber, pin, { consume: false });
    res.json({
      valid: data
    });
  } catch (error) {
    next(error);
  }
}

const updatePassword = async (req, res, next) => {
  const { password, userRole, id, pin } = req.body;
  let response;

  try {
    if (!userRole) {
      throw new Error("Invalid index number");
    }

    // Re-verify AND consume the code here (single-use). The password is only
    // changed if the code is valid/unexpired/not-locked.
    if (!(await verifyResetPin(`${userRole}/${id}`, pin, { consume: true }))) {
      throw new Error("Invalid user");
    }

    if (userRole === "STAFF") {
      response = await changeTeacherPassword(id, password);
    } else {
      response = await changeStudentPassword(id, password);
    }

    res.json(response);
  } catch (error) {
    next(error);
  }
};

// Add a single subject result without affecting other subjects
const addSingleSubjectResult = async (req, res, next) => {
  const values = req.body;
  try {
    const result = await createMarksResult({
      ...values,
      studentId: values.studentId,
      subjectId: values.subjectId,
      class: values.class,
      term: values.term,
      termId: values.termId,
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
};

// Update or insert a single subject result (upsert)
const upsertSingleSubjectResult = async (req, res, next) => {
  const values = req.body;
  try {
    const result = await upsertMarksResult({
      ...values,
      studentId: values.studentId,
      subjectId: values.subjectId,
      class: values.class,
      term: values.term,
      termId: values.termId,
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
};

export {
  fetchDashboardSummary,
  fetchStudentsOwing,
  fetchAllStudents,
  fetchAllStaff,
  fetchClassResult,
  fetchClassMarks,
  fetchOneStudentResult,
  fetchOneKGStudentResult,
  fetchClassKGResult,
  fetchAttendance,
  fetchAttendanceCount,
  fetchFees,
  fetchOneFee,
  fetchActiveTerm,
  fetchTerms,
  closeTerm,
  fetchFeeding,
  fetchExtraClasses,
  fetchBusFee,
  fetchSalary,
  fetchDeductions,
  fetchAllowances,
  fetchOneSalary,
  fetchSalaryPayment,
  fetchEmployeeSalary,
  fetchTotalStudentAttendance,
  addStudent,
  addStaff,
  addClass,
  addResult,
  addKGResult,
  addFee,
  addEvent,
  addSalary,
  addSalaryPayment,
  addFeeding,
  addBusFee,
  addExtraClasses,
  addClassFee,
  addTerm,
  addStudentFee,
  updateStudentFee,
  updateStudent,
  updateStaff,
  updateClass,
  updateClassFee,
  updateTerm,
  updateEvent,
  updateSalary,
  deleteStudent,
  deleteStaff,
  deleteResult,
  deleteFee,
  deleteSalary,
  deleteSalaryPayment,
  deleteClass,
  deleteClassFee,
  deleteFeeding,
  deleteExtraClasses,
  deleteBusFee,
  deleteAttendance,
  deleteEvent,
  deleteStudentFee,
  markAttendance,
  calculateTotalAttendance,
  assignSalary,
  fetchNews,
  fetchUserDetails,
  resetPin,
  updatePassword,
  addSingleSubjectResult,
  upsertSingleSubjectResult,
  verifyPin
};
