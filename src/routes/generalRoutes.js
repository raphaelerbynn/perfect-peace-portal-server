import { Router } from "express";
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
import {
  fetchClass,
} from "../controllers/onlyTeacherController.js";
import {
  fetchSubject,
  addSubject,
  deleteSubject,
} from "../controllers/subjectController.js";
import { fetchExpenseGraph, fetchFeesGraph, fetchFeesVsExpenseGraph, fetchIncomeGraph, fetchProfitLoss } from "../controllers/graphDataController.js";

const router = Router();

// Role helpers (mirrors docs/management-system-features.md §15).
// Category literals: "Administrator", "Class Teacher", "Accountant".
const ADMIN_ONLY = authorizeRoles("Administrator");
const ALL_ROLES = authorizeRoles("Administrator", "Class Teacher", "Accountant");
const ACADEMIC = authorizeRoles("Administrator", "Class Teacher");   // hidden for Accountant
const FINANCE = authorizeRoles("Administrator", "Accountant");       // hidden for Class Teacher

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
// BE-D4: close-term promotes students AND deactivates the active term — a
// state-mutating, non-idempotent operation that must NOT be a GET. Frontend
// already calls POST and expects { message } on success.
router.post("/close-term", ADMIN_ONLY, closeTerm);            // mutating term state: Administrator

// --- Staff (Administrator only) ---
// Authenticated replacement for the removed unauthenticated `app.get("/staff")`.
router.get("/staff", ADMIN_ONLY, fetchAllStaff);

// --- Students (hidden for Accountant) ---
router.get("/students", ACADEMIC, fetchAllStudents);

// --- Student Reports / Results (hidden for Accountant) ---
router.get("/student-results", ACADEMIC, fetchClassResult);
router.get("/student-marks", ACADEMIC, fetchOneStudentResult);
router.get("/kg-assessment", ACADEMIC, fetchOneKGStudentResult);
router.get("/student-kg-results", ACADEMIC, fetchClassKGResult);

// --- Attendance (hidden for Accountant) ---
router.get("/student-attendance", ACADEMIC, fetchAttendance);
router.get("/student-attendance-count", ACADEMIC, fetchAttendanceCount);
router.get("/student-total-attendance", ACADEMIC, fetchTotalStudentAttendance);
router.get("/calculate-term-attendance", ACADEMIC, calculateTotalAttendance);

// --- Fees (hidden for Class Teacher) ---
router.get("/fees", FINANCE, fetchFees);
router.get("/fees/:fee_id", FINANCE, fetchOneFee);

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
router.post("/add-news", ADMIN_ONLY, addEvent);               // Events add: Administrator

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
router.put("/update-news/:news_id", ADMIN_ONLY, updateEvent);
router.put("/update-salary/:salary_id", FINANCE, updateSalary);

// --- Deletes ---
router.delete("/delete-student/:student_id", ADMIN_ONLY, deleteStudent);
router.delete("/delete-staff/:teacher_id", ADMIN_ONLY, deleteStaff);
router.delete("/delete-class/:class_id", ADMIN_ONLY, deleteClass);
router.delete("/delete-class-fee/:class_fee_id", FINANCE, deleteClassFee);     // BE-4: finance op (was ADMIN_ONLY)
router.delete("/delete-student-fee/:student_fee_id", FINANCE, deleteStudentFee); // BE-4: finance op (was ADMIN_ONLY)
router.delete("/delete-result", ACADEMIC, deleteResult);
router.delete("/delete-fee/:fee_id", FINANCE, deleteFee);
router.delete("/delete-subject/:subject_id", ADMIN_ONLY, deleteSubject);
router.delete("/delete-salary/:salary_id", FINANCE, deleteSalary);
router.delete("/delete-salary-payment/:payment_id", FINANCE, deleteSalaryPayment);
router.delete("/delete-feeding/:feeding_id", FINANCE, deleteFeeding);
router.delete("/delete-extra-classes/:extraclasses_id", FINANCE, deleteExtraClasses);
router.delete("/delete-bus-fee/:busfee_id", FINANCE, deleteBusFee);
router.delete("/delete-news/:news_id", ADMIN_ONLY, deleteEvent);


//graph routes — Data Visualization accounting charts hidden for Class Teacher
router.get("/expense-graph", FINANCE, fetchExpenseGraph);
router.get("/income-graph", FINANCE, fetchIncomeGraph);
router.get("/fees-graph", FINANCE, fetchFeesGraph);
router.get("/fees-vs-expense-graph", FINANCE, fetchFeesVsExpenseGraph);
router.get("/profit-loss", FINANCE, fetchProfitLoss);

export { router as generalRouter };
