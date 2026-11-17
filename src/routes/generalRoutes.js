import { Router } from "express";
import {
  acceptClassPromotion,
  fetchClassOrder,
  fetchPromotionHistory,
  fetchPromotionPreview,
  fetchPromotionRules,
  fetchPromotionStatus,
  updateClassOrder,
  updatePromotionRules,
} from "../controllers/promotionController.js";
import { fetchClassReportCards, fetchReportCardCompleteness } from "../controllers/reportCardController.js";
import { fetchClassAttendanceSummary, fetchClassYearResults } from "../controllers/yearReportController.js";
import {
  addTimetableEntries,
  addTimetableEntry,
  copyTermTimetable,
  editTimetableEntry,
  fetchPeriods,
  fetchTimetable,
  removeTimetableEntry,
  savePeriods,
  syncTimetableAssignments,
} from "../controllers/timetableController.js";
import {
  addBusFee,
  addClass,
  addClassFee,
  addStudentFee,
  addExtraClasses,
  addFee,
  addFeeding,
  addKGResult,
  addResult,
  addSalary,
  addSalaryPayment,
  addSingleSubjectResult,
  addStaff,
  addStudent,
  assignSalary,
  deleteAttendance,
  deleteBusFee,
  deleteClass,
  deleteClassFee,
  deleteStudentFee,
  deleteExtraClasses,
  deleteFee,
  reverseFeePayment,
  deleteFeeding,
  deleteResult,
  deleteSalary,
  deleteSalaryPayment,
  deleteStaff,
  deleteStudent,
  fetchAllStaff,
  fetchAllStudents,
  fetchDashboardSummary,
  fetchStudentsOwing,
  fetchAttendance,
  fetchBusFee,
  fetchClassMarks,
  fetchClassResult,
  fetchEmployeeSalary,
  fetchExtraClasses,
  fetchFeeding,
  fetchFees,
  fetchNews,
  fetchOneFee,
  fetchOneSalary,
  fetchOneStudentResult,
  fetchOneKGStudentResult,
  fetchSalary,
  fetchSalaryPayment,
  fetchUserDetails,
  markAttendance,
  resetPin,
  updateClass,
  updateClassFee,
  updatePassword,
  updateStaff,
  updateStudent,
  fetchClassKGResult,
  fetchAttendanceCount,
  addTerm,
  fetchActiveTerm,
  closeTerm,
  updateTerm,
  calculateTotalAttendance,
  fetchTerms,
  addEvent,
  deleteEvent,
  updateEvent,
  updateSalary,
  fetchTotalStudentAttendance,
  upsertSingleSubjectResult,
  updateStudentFee
} from "../controllers/generalController.js";
import { authenticateUser, authorizeRoles } from "../utils/middlewares.js";
import { ACCOUNTANT, ADMINISTRATOR, CLASS_TEACHER, HEAD_TEACHER, OFFICE_ROLES } from "../utils/roles.js";
import {
  fetchClass,
} from "../controllers/onlyTeacherController.js";
import {
  fetchSubject,
  addSubject,
  deleteSubject,
} from "../controllers/subjectController.js";
import { fetchExpenseGraph, fetchFeesGraph, fetchFeesVsExpenseGraph, fetchIncomeGraph, fetchProfitLoss } from "../controllers/graphDataController.js";

import {
  copyTermTeachingAssignments,
  deleteTeachingAssignment,
  fetchTeachingAssignments,
  upsertTeachingAssignment,
} from "../controllers/teacherController.js";

import {
  addGradingScale,
  editGradingScale,
  fetchClassGrading,
  fetchGradingScales,
  removeGradingScale,
} from "../controllers/gradingController.js";
import { fetchClassSubjectScores, saveClassSubjectScoresSheet } from "../controllers/scoreSheetController.js";

const router = Router();

// Role helpers (mirrors docs/management-system-features.md §15). Role names
// live in utils/roles.js. B10: the Head Teacher does every academic job for
// every class (ACADEMIC, ACADEMIC_LEAD) but no money, settings or records
// administration (ADMIN_ONLY, FINANCE).
const ADMIN_ONLY = authorizeRoles(ADMINISTRATOR);
const ALL_ROLES = authorizeRoles(...OFFICE_ROLES);
const ACADEMIC = authorizeRoles(ADMINISTRATOR, CLASS_TEACHER, HEAD_TEACHER);   // hidden for Accountant
const ACADEMIC_LEAD = authorizeRoles(ADMINISTRATOR, HEAD_TEACHER);              // school-wide academic work
const FINANCE = authorizeRoles(ADMINISTRATOR, ACCOUNTANT);                      // hidden for Class Teacher, Head Teacher

// --- Shared / dashboard reads (visible to everyone) ---
// BE-D2 / BE-D9: dashboard data layer. Same access as the dashboard itself
// (all management roles).
router.get("/dashboard-summary", ALL_ROLES, fetchDashboardSummary);
router.get("/students-owing", ALL_ROLES, fetchStudentsOwing);
router.get("/news", ALL_ROLES, fetchNews);
// /user-details is a PORTAL (student/teacher) endpoint, authed separately.
router.get("/user-details", authenticateUser, fetchUserDetails);
router.get("/class", ALL_ROLES, fetchClass);                  // Classes view: all roles
router.get("/subject", ACADEMIC, fetchSubject);               // Subjects view: hidden for Accountant
router.get("/events", ALL_ROLES, fetchNews);
router.get("/active-term", ALL_ROLES, fetchActiveTerm);       // term metadata: shared
router.get("/terms", ALL_ROLES, fetchTerms);
// BE-D4: close-term deactivates the active term (B5: it no longer promotes) — a
// state-mutating, non-idempotent operation that must NOT be a GET. Frontend
// already calls POST and expects { message } on success.
router.post("/close-term", ADMIN_ONLY, closeTerm);

// --- B5: promotion. Moving pupils is Administrator + Head Teacher (B10);
// close-term no longer promotes (see services/term.js inactivateTerms).
router.get("/promotion/rules", ACADEMIC_LEAD, fetchPromotionRules);
router.put("/promotion/rules", ACADEMIC_LEAD, updatePromotionRules);
router.get("/promotion/class-order", ACADEMIC_LEAD, fetchClassOrder);
router.put("/promotion/class-order", ADMIN_ONLY, updateClassOrder);    // edits Class.nextClassId / isAlumni: class records
router.get("/promotion/preview", ACADEMIC_LEAD, fetchPromotionPreview);
router.post("/promotion/accept", ACADEMIC_LEAD, acceptClassPromotion);
router.get("/promotion/status", ACADEMIC_LEAD, fetchPromotionStatus);
router.get("/promotion/history/:studentId", ACADEMIC, fetchPromotionHistory);            // mutating term state: Administrator

// --- Staff list (Administrator; B10: + Head Teacher, read only) ---
// Authenticated replacement for the removed unauthenticated `app.get("/staff")`.
router.get("/staff", ACADEMIC_LEAD, fetchAllStaff);

// --- Students (hidden for Accountant) ---
// All office roles: Accountants pick pupils when recording fees. Class Teachers
// are scoped to their class in getStudents.
router.get("/students", ALL_ROLES, fetchAllStudents);

// --- Student Reports / Results (hidden for Accountant) ---
router.get("/student-results", ACADEMIC, fetchClassResult);
router.get("/student-marks", ACADEMIC, fetchOneStudentResult);
router.get("/kg-assessment", ACADEMIC, fetchOneKGStudentResult);
router.get("/student-kg-results", ACADEMIC, fetchClassKGResult);
// B4: check a class before printing, then every card in one payload.
router.get("/report-cards/completeness", ACADEMIC, fetchReportCardCompleteness);
router.get("/report-cards/class", ACADEMIC, fetchClassReportCards);
// B7: a class's results over a whole academic year.
router.get("/class-results/year", ACADEMIC, fetchClassYearResults);

// --- Attendance (hidden for Accountant) ---
router.get("/student-attendance", ACADEMIC, fetchAttendance);
router.get("/student-attendance-count", ACADEMIC, fetchAttendanceCount);
router.get("/student-total-attendance", ACADEMIC, fetchTotalStudentAttendance);
// B7: a class's attendance per pupil for one term or a whole year.
router.get("/attendance-summary", ACADEMIC, fetchClassAttendanceSummary);
// Rolls up AND deletes the term's daily registers: Administrator only.
router.get("/calculate-term-attendance", ADMIN_ONLY, calculateTotalAttendance);

// --- Fees (hidden for Class Teacher) ---
router.get("/fees", FINANCE, fetchFees);
router.get("/fees/:fee_id", FINANCE, fetchOneFee);
// B13: reversing a payment is Administrator-only (recording stays FINANCE).
router.post("/fees/:fee_id/reverse", ADMIN_ONLY, reverseFeePayment);

// --- Ancillary fee collectors (Accounting domain; hidden for Class Teacher) ---
router.get("/feeding", FINANCE, fetchFeeding);
router.get("/extra-classes", FINANCE, fetchExtraClasses);
router.get("/bus-fee", FINANCE, fetchBusFee);

// --- Payroll / Salary (hidden for Class Teacher) ---
router.get("/salary", FINANCE, fetchSalary);
router.get("/salary/:salary_id", FINANCE, fetchOneSalary);
router.get("/salary-payment", FINANCE, fetchSalaryPayment);
router.get("/employee-salary", FINANCE, fetchEmployeeSalary);

// --- Creates ---
router.post("/add-student", ADMIN_ONLY, addStudent);          // Students add: Administrator
router.post("/add-class", ADMIN_ONLY, addClass);              // Classes add: Administrator
router.post("/add-staff", ADMIN_ONLY, addStaff);              // Staff: Administrator only
router.post("/add-result", ACADEMIC, addResult);
router.post("/add-single-subject-result", ACADEMIC, addSingleSubjectResult);
router.post("/upsert-single-subject-result", ACADEMIC, upsertSingleSubjectResult);
router.post("/add-kg-result", ACADEMIC, addKGResult);
router.post("/add-fee", FINANCE, addFee);
router.post("/add-subject", ADMIN_ONLY, addSubject);          // Subjects add: Administrator
router.post("/add-salary", FINANCE, addSalary);
router.post("/add-salary-payment", FINANCE, addSalaryPayment);
router.post("/add-feeding", FINANCE, addFeeding);
router.post("/add-bus-fee", FINANCE, addBusFee);
router.post("/add-extra-classes", FINANCE, addExtraClasses);
router.post("/add-class-fee", FINANCE, addClassFee);       // BE-4: finance op (was ADMIN_ONLY) — Accountant manages fee amounts
router.post("/add-student-fee", FINANCE, addStudentFee);   // BE-4: finance op (was ADMIN_ONLY)
router.post("/add-term", ADMIN_ONLY, addTerm);
router.post("/add-news", ACADEMIC_LEAD, addEvent);               // Events add: Administrator, Head Teacher

// B2: who teaches which subject in which class, per term (Administrator, Head Teacher).
router.get("/teaching-assignments", ACADEMIC_LEAD, fetchTeachingAssignments);
router.post("/teaching-assignments", ACADEMIC_LEAD, upsertTeachingAssignment);
router.post("/teaching-assignments/copy", ACADEMIC_LEAD, copyTermTeachingAssignments);
router.delete("/teaching-assignments/:id", ACADEMIC_LEAD, deleteTeachingAssignment);

// --- B8: grading scales. Everyone who enters results can read them (live
// remark previews); the Administrator and Head Teacher change them.
router.get("/grading-scales", ACADEMIC, fetchGradingScales);
router.get("/grading-scales/for-class", ACADEMIC, fetchClassGrading);
router.post("/grading-scales", ACADEMIC_LEAD, addGradingScale);
router.put("/grading-scales/:id", ACADEMIC_LEAD, editGradingScale);
router.delete("/grading-scales/:id", ACADEMIC_LEAD, removeGradingScale);

// --- B6: one subject for a whole class (Upload scores page). Class Teachers
// are scoped to their own class in services/scoreSheet.js.
router.get("/class-subject-scores", ACADEMIC, fetchClassSubjectScores);
router.post("/class-subject-scores", ACADEMIC, saveClassSubjectScoresSheet);

// --- B3: timetable. Everyone in the office can read it; only the
// Administrator and Head Teacher build it (TODO B3 Q4, B10). Fixed paths before "/timetable/:id".
router.get("/timetable/periods", ALL_ROLES, fetchPeriods);
router.put("/timetable/periods", ACADEMIC_LEAD, savePeriods);
router.post("/timetable/bulk", ACADEMIC_LEAD, addTimetableEntries);
router.post("/timetable/copy", ACADEMIC_LEAD, copyTermTimetable);
router.post("/timetable/sync-assignments", ACADEMIC_LEAD, syncTimetableAssignments);
router.get("/timetable", ALL_ROLES, fetchTimetable);
router.post("/timetable", ACADEMIC_LEAD, addTimetableEntry);
router.put("/timetable/:id", ACADEMIC_LEAD, editTimetableEntry);
router.delete("/timetable/:id", ACADEMIC_LEAD, removeTimetableEntry);

router.post("/mark-attendance", ACADEMIC, markAttendance);
router.post("/delete-attendance", ACADEMIC, deleteAttendance);
router.post("/assign-salary", FINANCE, assignSalary);

// --- Updates ---
router.put("/update-student/:student_id", ADMIN_ONLY, updateStudent);
router.put("/update-staff/:teacher_id", ADMIN_ONLY, updateStaff);
router.put("/update-class-fee/:class_fee_id", FINANCE, updateClassFee);     // BE-4: finance op (was ADMIN_ONLY)
router.put("/update-student-fee/:student_fee_id", FINANCE, updateStudentFee); // BE-4: finance op (was ADMIN_ONLY)
router.put("/update-class/:class_id", ADMIN_ONLY, updateClass);
router.put("/update-term/:term_id", ADMIN_ONLY, updateTerm);
router.put("/update-news/:news_id", ACADEMIC_LEAD, updateEvent);
router.put("/update-salary/:salary_id", FINANCE, updateSalary);

// --- Deletes ---
router.delete("/delete-student/:student_id", ADMIN_ONLY, deleteStudent);
router.delete("/delete-staff/:teacher_id", ADMIN_ONLY, deleteStaff);
router.delete("/delete-class/:class_id", ADMIN_ONLY, deleteClass);
router.delete("/delete-class-fee/:class_fee_id", FINANCE, deleteClassFee);     // BE-4: finance op (was ADMIN_ONLY)
router.delete("/delete-student-fee/:student_fee_id", FINANCE, deleteStudentFee); // BE-4: finance op (was ADMIN_ONLY)
router.delete("/delete-result", ACADEMIC, deleteResult);
router.delete("/delete-fee/:fee_id", FINANCE, deleteFee); // B13: now 410 Gone — use /fees/:id/reverse
router.delete("/delete-subject/:subject_id", ADMIN_ONLY, deleteSubject);
router.delete("/delete-salary/:salary_id", FINANCE, deleteSalary);
router.delete("/delete-salary-payment/:payment_id", FINANCE, deleteSalaryPayment);
router.delete("/delete-feeding/:feeding_id", FINANCE, deleteFeeding);
router.delete("/delete-extra-classes/:extraclasses_id", FINANCE, deleteExtraClasses);
router.delete("/delete-bus-fee/:busfee_id", FINANCE, deleteBusFee);
router.delete("/delete-news/:news_id", ACADEMIC_LEAD, deleteEvent);


//graph routes — Data Visualization accounting charts hidden for Class Teacher
router.get("/expense-graph", FINANCE, fetchExpenseGraph);
router.get("/income-graph", FINANCE, fetchIncomeGraph);
router.get("/fees-graph", FINANCE, fetchFeesGraph);
router.get("/fees-vs-expense-graph", FINANCE, fetchFeesVsExpenseGraph);
router.get("/profit-loss", FINANCE, fetchProfitLoss);

export { router as generalRouter };
