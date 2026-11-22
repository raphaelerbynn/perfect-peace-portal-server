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
import { authenticateUser, requirePermission as can } from "../utils/middlewares.js";
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

// B10: every route is gated by a permission (utils/permissions.js), never by
// a role name. The comments name who had it before B10 (A = Administrator,
// CT = Class Teacher, Acc = Accountant); the system roles still do.
// Class Teachers stay limited to their own class in the services, unless a
// role holds academics.all_classes.

// --- Shared / dashboard reads (visible to everyone) ---
// BE-D2 / BE-D9: dashboard data layer. Same access as the dashboard itself
// (all management roles).
router.get("/dashboard-summary", can("overview.dashboard"), fetchDashboardSummary);
router.get("/students-owing", can("overview.dashboard"), fetchStudentsOwing);
router.get("/news", can("news.view"), fetchNews);
// /user-details is a PORTAL (student/teacher) endpoint, authed separately.
router.get("/user-details", authenticateUser, fetchUserDetails);
router.get("/class", can("classes.view"), fetchClass);                  // Classes view: all roles
router.get("/subject", can("subjects.view"), fetchSubject);               // Subjects view: hidden for Accountant
router.get("/events", can("news.view"), fetchNews);
router.get("/active-term", can("terms.view"), fetchActiveTerm);       // term metadata: shared
router.get("/terms", can("terms.view"), fetchTerms);
// BE-D4: close-term deactivates the active term (B5: it no longer promotes) - a
// state-mutating, non-idempotent operation that must NOT be a GET. Frontend
// already calls POST and expects { message } on success.
router.post("/close-term", can("terms.manage"), closeTerm);

// --- B5: promotion (A). The class ladder itself is a class record (classes.manage);
// close-term no longer promotes (see services/term.js inactivateTerms).
router.get("/promotion/rules", can("promotion.manage"), fetchPromotionRules);
router.put("/promotion/rules", can("promotion.manage"), updatePromotionRules);
router.get("/promotion/class-order", can("promotion.manage"), fetchClassOrder);
router.put("/promotion/class-order", can("classes.manage"), updateClassOrder);    // edits Class.nextClassId / isAlumni: class records
router.get("/promotion/preview", can("promotion.manage"), fetchPromotionPreview);
router.post("/promotion/accept", can("promotion.manage"), acceptClassPromotion);
router.get("/promotion/status", can("promotion.manage"), fetchPromotionStatus);
router.get("/promotion/history/:studentId", can("promotion.view_history"), fetchPromotionHistory); // A CT (own class)

// --- Staff list (A; bank and payroll fields need staff.view_sensitive) ---
// Authenticated replacement for the removed unauthenticated `app.get("/staff")`.
router.get("/staff", can("staff.view"), fetchAllStaff);

// --- Students (hidden for Accountant) ---
// All office roles: Accountants pick pupils when recording fees. Class Teachers
// are scoped to their class in getStudents.
router.get("/students", can("students.view", "overview.lookups"), fetchAllStudents);

// --- Student Reports / Results (hidden for Accountant) ---
router.get("/student-results", can("results.view"), fetchClassResult);
router.get("/student-marks", can("results.view"), fetchOneStudentResult);
router.get("/kg-assessment", can("results.view"), fetchOneKGStudentResult);
router.get("/student-kg-results", can("results.view"), fetchClassKGResult);
// B4: check a class before printing, then every card in one payload.
router.get("/report-cards/completeness", can("report_cards.view"), fetchReportCardCompleteness);
router.get("/report-cards/class", can("report_cards.view"), fetchClassReportCards);
// B7: a class's results over a whole academic year.
router.get("/class-results/year", can("results.view"), fetchClassYearResults);

// --- Attendance (hidden for Accountant) ---
router.get("/student-attendance", can("attendance.view"), fetchAttendance);
router.get("/student-attendance-count", can("attendance.view"), fetchAttendanceCount);
router.get("/student-total-attendance", can("attendance.view"), fetchTotalStudentAttendance);
// B7: a class's attendance per pupil for one term or a whole year.
router.get("/attendance-summary", can("attendance.view"), fetchClassAttendanceSummary);
// Rolls up AND deletes the term's daily registers: Administrator only.
router.get("/calculate-term-attendance", can("terms.manage"), calculateTotalAttendance);

// --- Fees (hidden for Class Teacher) ---
router.get("/fees", can("fees.view"), fetchFees);
router.get("/fees/:fee_id", can("fees.view"), fetchOneFee);
// B13: reversing a payment is Administrator-only (recording: A Acc).
router.post("/fees/:fee_id/reverse", can("fees.reverse"), reverseFeePayment);

// --- Ancillary fee collectors (Accounting domain; hidden for Class Teacher) ---
router.get("/feeding", can("fees.other_collections"), fetchFeeding);
router.get("/extra-classes", can("fees.other_collections"), fetchExtraClasses);
router.get("/bus-fee", can("fees.other_collections"), fetchBusFee);

// --- Payroll / Salary (hidden for Class Teacher) ---
router.get("/salary", can("payroll.view"), fetchSalary);
router.get("/salary/:salary_id", can("payroll.view"), fetchOneSalary);
router.get("/salary-payment", can("payroll.view"), fetchSalaryPayment);
router.get("/employee-salary", can("payroll.view"), fetchEmployeeSalary);

// --- Creates ---
router.post("/add-student", can("students.edit"), addStudent);          // Students add: Administrator
router.post("/add-class", can("classes.manage"), addClass);              // Classes add: Administrator
router.post("/add-staff", can("staff.edit"), addStaff);              // Staff: Administrator only
router.post("/add-result", can("results.enter"), addResult);
router.post("/add-single-subject-result", can("results.enter"), addSingleSubjectResult);
router.post("/upsert-single-subject-result", can("results.enter"), upsertSingleSubjectResult);
router.post("/add-kg-result", can("results.enter"), addKGResult);
router.post("/add-fee", can("fees.record"), addFee);
router.post("/add-subject", can("subjects.manage"), addSubject);          // Subjects add: Administrator
router.post("/add-salary", can("payroll.manage"), addSalary);
router.post("/add-salary-payment", can("payroll.manage"), addSalaryPayment);
router.post("/add-feeding", can("fees.other_collections"), addFeeding);
router.post("/add-bus-fee", can("fees.other_collections"), addBusFee);
router.post("/add-extra-classes", can("fees.other_collections"), addExtraClasses);
router.post("/add-class-fee", can("fees.setup"), addClassFee);       // BE-4: finance op (A Acc) - Accountant manages fee amounts
router.post("/add-student-fee", can("fees.setup"), addStudentFee);   // BE-4: finance op (A Acc)
router.post("/add-term", can("terms.manage"), addTerm);
router.post("/add-news", can("news.manage"), addEvent);               // Events add: Administrator

// B2: who teaches which subject in which class, per term (A).
router.get("/teaching-assignments", can("subjects.assign_teachers"), fetchTeachingAssignments);
router.post("/teaching-assignments", can("subjects.assign_teachers"), upsertTeachingAssignment);
router.post("/teaching-assignments/copy", can("subjects.assign_teachers"), copyTermTeachingAssignments);
router.delete("/teaching-assignments/:id", can("subjects.assign_teachers"), deleteTeachingAssignment);

// --- B8: grading scales. Everyone who enters results can read them (live
// remark previews); the Administrator changes them.
router.get("/grading-scales", can("grading.view"), fetchGradingScales);
router.get("/grading-scales/for-class", can("grading.view"), fetchClassGrading);
router.post("/grading-scales", can("grading.manage"), addGradingScale);
router.put("/grading-scales/:id", can("grading.manage"), editGradingScale);
router.delete("/grading-scales/:id", can("grading.manage"), removeGradingScale);

// --- B6: one subject for a whole class (Upload scores page). Class Teachers
// are scoped to their own class in services/scoreSheet.js.
router.get("/class-subject-scores", can("results.enter"), fetchClassSubjectScores);
router.post("/class-subject-scores", can("results.enter"), saveClassSubjectScoresSheet);

// --- B3: timetable. Everyone in the office can read it; only the
// Administrator builds it (TODO B3 Q4). Fixed paths before "/timetable/:id".
router.get("/timetable/periods", can("timetable.view", "overview.lookups"), fetchPeriods);
router.put("/timetable/periods", can("timetable.manage"), savePeriods);
router.post("/timetable/bulk", can("timetable.manage"), addTimetableEntries);
router.post("/timetable/copy", can("timetable.manage"), copyTermTimetable);
router.post("/timetable/sync-assignments", can("timetable.manage"), syncTimetableAssignments);
router.get("/timetable", can("timetable.view", "overview.lookups"), fetchTimetable);
router.post("/timetable", can("timetable.manage"), addTimetableEntry);
router.put("/timetable/:id", can("timetable.manage"), editTimetableEntry);
router.delete("/timetable/:id", can("timetable.manage"), removeTimetableEntry);

router.post("/mark-attendance", can("attendance.mark"), markAttendance);
router.post("/delete-attendance", can("attendance.mark"), deleteAttendance);
router.post("/assign-salary", can("payroll.manage"), assignSalary);

// --- Updates ---
router.put("/update-student/:student_id", can("students.edit"), updateStudent);
router.put("/update-staff/:teacher_id", can("staff.edit"), updateStaff);
router.put("/update-class-fee/:class_fee_id", can("fees.setup"), updateClassFee);     // BE-4: finance op (A Acc)
router.put("/update-student-fee/:student_fee_id", can("fees.setup"), updateStudentFee); // BE-4: finance op (A Acc)
router.put("/update-class/:class_id", can("classes.manage"), updateClass);
router.put("/update-term/:term_id", can("terms.manage"), updateTerm);
router.put("/update-news/:news_id", can("news.manage"), updateEvent);
router.put("/update-salary/:salary_id", can("payroll.manage"), updateSalary);

// --- Deletes ---
router.delete("/delete-student/:student_id", can("students.delete"), deleteStudent);
router.delete("/delete-staff/:teacher_id", can("staff.delete"), deleteStaff);
router.delete("/delete-class/:class_id", can("classes.manage"), deleteClass);
router.delete("/delete-class-fee/:class_fee_id", can("fees.setup"), deleteClassFee);     // BE-4: finance op (A Acc)
router.delete("/delete-student-fee/:student_fee_id", can("fees.setup"), deleteStudentFee); // BE-4: finance op (A Acc)
router.delete("/delete-result", can("results.delete"), deleteResult);
router.delete("/delete-fee/:fee_id", can("fees.record"), deleteFee); // B13: now 410 Gone — use /fees/:id/reverse
router.delete("/delete-subject/:subject_id", can("subjects.manage"), deleteSubject);
router.delete("/delete-salary/:salary_id", can("payroll.manage"), deleteSalary);
router.delete("/delete-salary-payment/:payment_id", can("payroll.manage"), deleteSalaryPayment);
router.delete("/delete-feeding/:feeding_id", can("fees.other_collections"), deleteFeeding);
router.delete("/delete-extra-classes/:extraclasses_id", can("fees.other_collections"), deleteExtraClasses);
router.delete("/delete-bus-fee/:busfee_id", can("fees.other_collections"), deleteBusFee);
router.delete("/delete-news/:news_id", can("news.manage"), deleteEvent);


//graph routes - Data Visualization accounting charts hidden for Class Teacher
router.get("/expense-graph", can("accounting.view"), fetchExpenseGraph);
router.get("/income-graph", can("accounting.view"), fetchIncomeGraph);
router.get("/fees-graph", can("accounting.view"), fetchFeesGraph);
router.get("/fees-vs-expense-graph", can("accounting.view"), fetchFeesVsExpenseGraph);
router.get("/profit-loss", can("accounting.view"), fetchProfitLoss);

export { router as generalRouter };
