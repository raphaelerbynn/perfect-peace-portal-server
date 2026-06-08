import { DataTypes } from "sequelize";
import Allowance from "./Allowance.js";
import Assignment from "./Assignment.js";
import Attendance from "./Attendance.js";
import BusFee from "./BusFee.js";
import Class from "./Class.js";
import ClassFee from "./ClassFee.js";
import StudentFee from "./StudentFee.js";
import EmployeeSalary from "./EmployeeSalary.js";
import Event from "./Event.js";
import AccountCategory from "./AccountCategory.js";
import Income from "./Income.js";
import Expense from "./Expense.js";
import ExtraClasses from "./ExtraClasses.js";
import Fee from "./Fee.js";
import FeeCheck from "./FeeCheck.js";
import FeedingFee from "./FeedingFee.js";
import KgAssessment from "./KgAssessment.js";
import Notification from "./Notification.js";
import Parent from "./Parent.js";
import Salary from "./Salary.js";
import SalaryPayment from "./SalaryPayment.js";
import Student from "./Student.js";
import StudentMarks from "./StudentMarks.js";
import StudentResult from "./StudentResult.js";
import Subject from "./Subject.js";
import Teacher from "./Teacher.js";
import TotalAttendance from "./TotalAttendance.js";
import UserAccount from "./UserAccount.js";
import Deductions from "./Deductions.js";
import Term from "./Term.js";
import Tax from "./Tax.js";
import PasswordResetCode from "./PasswordResetCode.js";

Allowance.belongsTo(Salary, { as: "salary", foreignKey: "salaryId" });
Salary.hasMany(Allowance, { as: "allowances", foreignKey: "salaryId" });

Teacher.belongsTo(Salary, { as: "salary", foreignKey: "salaryId" });
Salary.hasMany(Teacher, { as: "teacher", foreignKey: "salaryId" });

// Assignment.belongsTo(Student, { as: 'student', foreignKey: 'studentId' });
// Student.hasMany(Assignment, { as: 'assignments', foreignKey: 'studentId' });

Attendance.belongsTo(Student, { as: "student", foreignKey: "studentId" });
Student.hasMany(Attendance, { as: "attendances", foreignKey: "studentId" });

// BusFee.belongsTo(Student, { as: 'student', foreignKey: 'studentId' });
// Student.hasMany(BusFee, { as: 'busFees', foreignKey: 'studentId' });

Class.hasMany(Student, { as: "students", foreignKey: "classId" });
Student.belongsTo(Class, { foreignKey: "classId" });

EmployeeSalary.belongsTo(Teacher, { as: "teacher", foreignKey: "teacherId" });
Teacher.hasMany(EmployeeSalary, {
  as: "employeeSalaries",
  foreignKey: "teacherId",
});

Expense.belongsTo(AccountCategory, { foreignKey: 'accountCategoryId' });
AccountCategory.hasMany(Expense, { foreignKey: 'accountCategoryId' });

Income.belongsTo(AccountCategory, { foreignKey: 'accountCategoryId' });
AccountCategory.hasMany(Income, { foreignKey: 'accountCategoryId' });

Fee.belongsTo(Class, { as: "class", foreignKey: "classId" });
Class.hasMany(Fee, { as: "classFees", foreignKey: "classId" });

ClassFee.belongsTo(Class, { as: "class", foreignKey: "classId" });
Class.hasMany(ClassFee, { as: "classFee", foreignKey: "classId" });
StudentFee.belongsTo(Student, { as: "student", foreignKey: "studentId" });
Student.hasMany(StudentFee, { as: "studentFee", foreignKey: "studentId" });
// FeedingFee.belongsTo(Student, { as: 'student', foreignKey: 'studentId' });
// Student.hasMany(FeedingFee, { as: 'feedingFees', foreignKey: 'studentId' });

KgAssessment.belongsTo(Student, { as: "student", foreignKey: "studentId" });
Student.hasMany(KgAssessment, { as: "kgAssessments", foreignKey: "studentId" });

Notification.belongsTo(Student, { as: "student", foreignKey: "studentId" });
Student.hasMany(Notification, { as: "notifications", foreignKey: "studentId" });

SalaryPayment.belongsTo(Salary, { as: "salary", foreignKey: "salaryId" });
Salary.hasMany(SalaryPayment, { as: "salaryPayments", foreignKey: "salaryId" });
Tax.belongsTo(Salary, { as: "salary", foreignKey: "salaryId" });
Salary.hasMany(Tax, { as: "tax", foreignKey: "salaryId" });

StudentMarks.belongsTo(Student, { as: "student", foreignKey: "studentId" });
Student.hasMany(StudentMarks, { as: "studentMarks", foreignKey: "studentId" });

// BE-W5: removed the bogus StudentMarks<->Class association that joined on
// `studentId` (it returned wrong rows). StudentMarks links to a class by the
// `class` name string; no Sequelize association is needed (reads use raw SQL).

Teacher.belongsTo(Class, { as: "class_", foreignKey: "classId" });
Class.hasOne(Teacher, { as: "teacher", foreignKey: "classId" });

Student.belongsTo(Parent, { as: "parent", foreignKey: "parentId" });

StudentResult.belongsTo(Student, { as: "student", foreignKey: "studentId" });
Student.hasMany(StudentResult, {
  as: "studentResults",
  foreignKey: "studentId",
});

StudentMarks.belongsTo(Subject, { as: "subject", foreignKey: "subjectId" });
Subject.hasMany(StudentMarks, { as: "studentMarks", foreignKey: "subjectId" });

TotalAttendance.belongsTo(Student, { as: "student", foreignKey: "studentId" });
Student.hasMany(TotalAttendance, {
  as: "totalAttendances",
  foreignKey: "studentId",
});

UserAccount.belongsTo(Teacher, { as: "teacher", foreignKey: "teacherId" });
Teacher.hasMany(UserAccount, { as: "userAccounts", foreignKey: "teacherId" });

Attendance.belongsTo(Term, { as: "term", foreignKey: "termId" });
Term.hasMany(Attendance, { as: "attendances", foreignKey: "termId" });

Student.hasMany(Fee, {
  foreignKey: "studentId",
  as: "fee",
});

export {
  Allowance,
  Assignment,
  Attendance,
  BusFee,
  Class,
  EmployeeSalary,
  Event,
  Expense,
  Income,
  AccountCategory,
  ExtraClasses,
  Fee,
  FeedingFee,
  KgAssessment,
  Notification,
  Parent,
  Salary,
  SalaryPayment,
  Student,
  StudentMarks,
  StudentResult,
  StudentFee,
  Subject,
  Teacher,
  TotalAttendance,
  UserAccount,
  FeeCheck,
  Deductions,
  Term,
  Tax,
  ClassFee,
  PasswordResetCode,
};
