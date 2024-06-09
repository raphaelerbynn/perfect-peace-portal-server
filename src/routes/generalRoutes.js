import { Router } from "express";
import {
  addBusFee,
  addClass,
  addClassFee,
  addExtraClasses,
  addFee,
  addFeeding,
  addKGResult,
  addResult,
  addSalary,
  addSalaryPayment,
  addStaff,
  addStudent,
  addSubject,
  assignSalary,
  deleteAttendance,
  deleteBusFee,
  deleteClass,
  deleteClassFee,
  deleteExtraClasses,
  deleteFee,
  deleteFeeding,
  deleteResult,
  deleteSalary,
  deleteSalaryPayment,
  deleteStaff,
  deleteStudent,
  deleteSubject,
  fetchAllStaff,
  fetchAllStudents,
  fetchAllowances,
  fetchAttendance,
  fetchBusFee,
  fetchClassMarks,
  fetchClassResult,
  fetchDeductions,
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
} from "../controllers/generalController.js";
import { authenticateUser } from "../utils/middlewares.js";
import {
  fetchClass,
  fetchSubject,
} from "../controllers/onlyTeacherController.js";
import { fetchExpenseGraph, fetchFeesGraph, fetchFeesVsExpenseGraph, fetchIncomeGraph } from "../controllers/graphDataController.js";
// import students from "../../students.json" assert { type: "json" };
// import { Class, KgAssessment, KgCalcValues, Parent, Student, StudentMarks, StudentResult, Subject, Teacher, UserAccount } from "../models/index.js";


const router = Router();

router.get("/news", fetchNews);
router.get("/user-details", authenticateUser, fetchUserDetails);
router.get("/get-pin", resetPin);
router.get("/class", fetchClass);
router.get("/subject", fetchSubject);

router.get("/events", fetchNews);
router.get("/active-term", fetchActiveTerm);
router.get("/close-term", closeTerm);
router.get("/students", fetchAllStudents);
router.get("/staff", fetchAllStaff);
router.get("/student-results", fetchClassResult);
router.get("/student-marks", fetchOneStudentResult);
router.get("/kg-assessment", fetchOneKGStudentResult);
router.get("/student-kg-results", fetchClassKGResult);
router.get("/student-attendance", fetchAttendance);
router.get("/student-attendance-count", fetchAttendanceCount);
router.get("/fees", fetchFees);
router.get("/fees/:fee_id", fetchOneFee);
router.get("/feeding", fetchFeeding);
router.get("/extra-classes", fetchExtraClasses);
router.get("/bus-fee", fetchBusFee);
router.get("/salary", fetchSalary);
router.get("/deductions", fetchDeductions);
router.get("/allowances", fetchAllowances);
router.get("/salary/:salary_id", fetchOneSalary);
router.get("/salary-payment", fetchSalaryPayment);
router.get("/employee-salary", fetchEmployeeSalary);
router.get("/calculate-term-attendance", calculateTotalAttendance);
// router.get("/teachers-weekly-report", fetchWeeklyReport);

router.post("/add-student", addStudent);
router.post("/add-class", addClass);
router.post("/add-staff", addStaff);
router.post("/add-result", addResult);
router.post("/add-kg-result", addKGResult);
router.post("/add-fee", addFee);
router.post("/add-subject", addSubject);
router.post("/add-salary", addSalary);
router.post("/add-salary-payment", addSalaryPayment);
router.post("/add-feeding", addFeeding);
router.post("/add-bus-fee", addBusFee);
router.post("/add-extra-classes", addExtraClasses);
router.post("/add-class-fee", addClassFee);
router.post("/add-term", addTerm);
// router.post("/ass-teachers-weekly-report", addWeeklyReport);
// router.post("/add-event", addEvent);

router.post("/mark-attendance", markAttendance);
router.post("/delete-attendance", deleteAttendance);
router.post("/assign-salary", assignSalary);

router.put("/update-student/:student_id", updateStudent);
router.put("/update-staff/:teacher_id", updateStaff);
router.put("/update-class-fee/:class_fee_id", updateClassFee);
router.put("/update-class/:class_id", updateClass);
router.put("/update-term/:term_id", updateTerm);

router.delete("/delete-student/:student_id", deleteStudent);
router.delete("/delete-staff/:teacher_id", deleteStaff);
router.delete("/delete-class/:class_id", deleteClass);
router.delete("/delete-class-fee/:class_fee_id", deleteClassFee);
router.delete("/delete-result", deleteResult);
router.delete("/delete-fee/:fee_id", deleteFee);
router.delete("/delete-subject/:subject_id", deleteSubject);
router.delete("/delete-salary/:salary_id", deleteSalary);
router.delete("/delete-salary-payment/:payment_id", deleteSalaryPayment);
router.delete("/delete-feeding/:feeding_id", deleteFeeding);
router.delete("/delete-extra-classes/:extraclasses_id", deleteExtraClasses);
router.delete("/delete-bus-fee/:busfee_id", deleteBusFee);

router.post("/update-password", updatePassword);


//graph routes
router.get("/expense-graph", fetchExpenseGraph);
router.get("/income-graph", fetchIncomeGraph);
router.get("/fees-graph", fetchFeesGraph);
router.get("/fees-vs-expense-graph", fetchFeesVsExpenseGraph);


//data imports
// router.get("/import-students", async (req, res, next) => {
//   try{
//     // const arr1 = await Student.findAll({ raw: true })
//     // const idNotInArr1 = students.filter(student1 => !arr1.some(student2 => student1.student_id == student2.studentId))
//     // console.log(students.length)
//     // for ( let student of idNotInArr1) {
//     //   const data = {
//     //     ...student,
//     //     studentId: student.student_id,
//     //     fName: student.f_name,
//     //     mName: student.m_name,
//     //     lName: student.l_name,
//     //     dateRegistered: student.date_registered,
//     //     dateUpdated: student.date_updated,
//     //     parentId: student.parent_id,
//     //     classId: student.class_id,
//     //     feesPaid: student.fees_paid,
//     //     feesOwing: student.fees_owing,
//     //   }
//     //   console.log("🚀", data)
//     //   const result = await Student.create(data)
//     // }

//     const studentData = students.map(student => ({
//       ...student,
//         kgAssessmentId: student.kg_assessment_id,
//         needsImprovement: student.needs_improvement,
//         notApplicable: student.not_applicable,
//         studentId: student.student_id,
//         classScore: student.class_score,
//         examScore: student.exam_score,
//         totalScore: student.total_score
//     }));

//     const createdStudentMarks = await KgAssessment.bulkCreate(studentData);
    
//     createdStudentMarks.forEach(studentMark => {
//       if (studentMark._options.isNewRecord) {
//         console.info('StudentMark created: 🚀', studentMark.toJSON());
//       } else {
//         console.warn('StudentMark already exists: 📜', studentMark.toJSON());
//       }
//     });
//     // const studentData = students.map(student => ({
//     //   ...student,
//     //     parentId: student.parent_id,
//     //     fName: student.f_name,
//     //     lName: student.l_name,
//     //     createdAt: student.created_at
//     // }));

//     // const createdStudentMarks = await Parent.bulkCreate(studentData, {
//     //   ignoreDuplicates: true,
//     // });
    
//     // createdStudentMarks.forEach(studentMark => {
//     //   if (studentMark._options.isNewRecord) {
//     //     console.info('StudentMark created: 🚀', studentMark.toJSON());
//     //   } else {
//     //     console.warn('StudentMark already exists: 📜', studentMark.toJSON());
//     //   }
//     // });

    
  

//     res.status(201).json({idNotInArr1: "done"})
//   } catch(err){
//     console.log(err)
//     next(err)
//   }
// });

export { router as generalRouter };
