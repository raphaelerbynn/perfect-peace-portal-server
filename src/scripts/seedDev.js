// DEV-ONLY seed. Inserts a small but representative dataset into the LOCAL
// Postgres so the management portal + API can be exercised end-to-end. Idempotent
// where practical (find-or-create on natural keys) so it can be re-run.
//
// Run from the HOST against the published DB port (5433):
//   DB_HOST=localhost DB_PORT=5433 DB_NAME=perfectpeace DB_USERNAME=perfectpeace \
//   DB_PASSWORD=perfectpeace_dev_pw npx babel-node src/scripts/seedDev.js
import bcrypt from "bcrypt";
import sequelize from "../config/database.js";
import {
  Salary,
  Class,
  Subject,
  Term,
  Teacher,
  Parent,
  Student,
  UserAccount,
  ClassFee,
  Fee,
  AccountCategory,
  Income,
  Expense,
} from "../models/index.js";

const ROUNDS = 10;
const ADMIN_PASSWORD = "Admin@12345";
const STUDENT_PASSWORD = "Student@123";
const TEACHER_PASSWORD = "Teacher@123";

// find-or-create helper that returns the instance only.
const foc = async (Model, where, defaults = {}) => {
  const [row] = await Model.findOrCreate({ where, defaults: { ...where, ...defaults } });
  return row;
};

const run = async () => {
  await sequelize.authenticate();
  console.log(`Connected to ${sequelize.getDatabaseName()} — seeding…`);

  const adminHash = await bcrypt.hash(ADMIN_PASSWORD, ROUNDS);
  const studentHash = await bcrypt.hash(STUDENT_PASSWORD, ROUNDS);
  const teacherHash = await bcrypt.hash(TEACHER_PASSWORD, ROUNDS);

  // --- Salary structures ---
  const salaryHead = await foc(Salary, { title: "Head Teacher Scale" }, { rank: "Senior", amount: 4500 });
  const salaryClass = await foc(Salary, { title: "Class Teacher Scale" }, { rank: "Junior", amount: 2500 });

  // --- Classes ---
  const class5 = await foc(Class, { name: "Class 5" }, { section: "A", capacity: 30, tuition: 600, fees: 850 });
  const kg1 = await foc(Class, { name: "KG 1" }, { section: "A", capacity: 25, tuition: 400, fees: 600 });

  // --- Subjects (with mark/percentage config used by the results system) ---
  const subjectDefs = [
    { name: "Mathematics" },
    { name: "English" },
    { name: "Integrated Science" },
    { name: "Social Studies" },
  ];
  const subjects = [];
  for (const s of subjectDefs) {
    subjects.push(
      await foc(Subject, { name: s.name }, {
        examTotalMarks: 100,
        classTotalMarks: 40,
        examPercentage: 60,
        classPercentage: 40,
        passMarks: 50,
      })
    );
  }

  // --- Terms (exactly one active) ---
  const term1 = await foc(Term, { term: "Term 1" }, { startDate: "2026-01-08", endDate: "2026-04-10", active: true });
  const term2 = await foc(Term, { term: "Term 2" }, { startDate: "2026-04-28", endDate: "2026-07-31", active: false });

  // --- Teachers (one Administrator, one Class Teacher, one Accountant) ---
  const adminTeacher = await foc(
    Teacher,
    { fName: "Kwame", lName: "Boateng" },
    {
      gender: "Male",
      phone: "0244000001",
      email: "kwame.admin@perfectpeace.test",
      category: "Administrator",
      staffPosition: "Head Teacher",
      salaryId: salaryHead.salaryId,
      password: teacherHash,
      dateRegistered: "2025-09-01",
    }
  );
  const classTeacher = await foc(
    Teacher,
    { fName: "Akosua", lName: "Owusu" },
    {
      gender: "Female",
      phone: "0244000002",
      email: "akosua.teacher@perfectpeace.test",
      category: "Class Teacher",
      staffPosition: "Class 5 Teacher",
      classId: class5.classId,
      salaryId: salaryClass.salaryId,
      password: teacherHash,
      dateRegistered: "2025-09-01",
    }
  );
  const accountant = await foc(
    Teacher,
    { fName: "Yaw", lName: "Asante" },
    {
      gender: "Male",
      phone: "0244000003",
      email: "yaw.accounts@perfectpeace.test",
      category: "Accountant",
      staffPosition: "Bursar",
      salaryId: salaryClass.salaryId,
      password: teacherHash,
      dateRegistered: "2025-09-01",
    }
  );

  // Link Class 5's class teacher back to the class row.
  if (class5.teacherId !== classTeacher.teacherId) {
    class5.teacherId = classTeacher.teacherId;
    await class5.save();
  }

  // --- Management login accounts (admin portal) ---
  const adminUser = await UserAccount.findByPk("admin");
  if (!adminUser) {
    await UserAccount.create({
      username: "admin",
      name: "Kwame Boateng",
      email: "kwame.admin@perfectpeace.test",
      category: "Administrator",
      password: adminHash,
      teacherId: adminTeacher.teacherId,
    });
  } else {
    adminUser.password = adminHash;
    adminUser.category = "Administrator";
    adminUser.teacherId = adminTeacher.teacherId;
    adminUser.isDeleted = false;
    await adminUser.save();
  }
  const acctUser = await UserAccount.findByPk("accountant");
  if (!acctUser) {
    await UserAccount.create({
      username: "accountant",
      name: "Yaw Asante",
      email: "yaw.accounts@perfectpeace.test",
      category: "Accountant",
      password: adminHash,
      teacherId: accountant.teacherId,
    });
  }

  // --- Parents ---
  const parent1 = await foc(Parent, { fName: "Esi", lName: "Appiah" }, { gender: "Female", contact: "0201000001", relationship: "Mother", occupation: "Trader" });
  const parent2 = await foc(Parent, { fName: "Kofi", lName: "Darko" }, { gender: "Male", contact: "0201000002", relationship: "Father", occupation: "Farmer" });

  // --- Students (assigned to Class 5) ---
  const studentDefs = [
    { fName: "Ama", lName: "Appiah", gender: "Female", dob: "2015-03-12", parentId: parent1.parentId },
    { fName: "Kojo", lName: "Darko", gender: "Male", dob: "2015-07-21", parentId: parent2.parentId },
    { fName: "Adwoa", lName: "Mensah", gender: "Female", dob: "2015-11-02", parentId: parent1.parentId },
    { fName: "Yaw", lName: "Owusu", gender: "Male", dob: "2015-01-30", parentId: parent2.parentId },
  ];
  const students = [];
  for (const s of studentDefs) {
    students.push(
      await foc(Student, { fName: s.fName, lName: s.lName }, {
        gender: s.gender,
        dob: s.dob,
        class: "Class 5",
        classId: class5.classId,
        parentId: s.parentId,
        password: studentHash,
        dateRegistered: "2025-09-05",
        feesPaid: 0,
        feesOwing: 850,
      })
    );
  }

  // --- Class fee breakdown (line items) for Class 5 ---
  const classFeeDefs = [
    { name: "Tuition", amount: 600 },
    { name: "Stationery", amount: 100 },
    { name: "PTA", amount: 50 },
    { name: "Water", amount: 100 },
  ];
  for (const cf of classFeeDefs) {
    await foc(ClassFee, { name: cf.name, classId: class5.classId }, { amount: cf.amount });
  }

  // --- A couple of fee payments ---
  const firstStudent = students[0];
  const existingFee = await Fee.findOne({ where: { studentId: firstStudent.studentId, term: "T1" } });
  if (!existingFee) {
    await Fee.create({
      studentId: firstStudent.studentId,
      classId: class5.classId,
      total: 850,
      paid: 500,
      remaining: 350,
      paymentMode: "Cash",
      amountInWords: "Five hundred Ghana cedis",
      term: "T1",
      datePaid: "2026-01-15",
    });
    firstStudent.feesPaid = 500;
    firstStudent.feesOwing = 350;
    await firstStudent.save();
  }

  // --- Accounting categories + a sample income/expense (for analytics) ---
  let incomeRan = false;
  try {
    const incomeCat = await foc(AccountCategory, { name: "School Fees" }, {});
    const expenseCat = await foc(AccountCategory, { name: "Utilities" }, {});
    await foc(Income, { description: "Term 1 fees collection" }, { amount: 500, accountCategoryId: incomeCat.accountCategoryId, date: "2026-01-15" }).catch(() => {});
    await foc(Expense, { description: "Electricity bill" }, { amount: 220, accountCategoryId: expenseCat.accountCategoryId, date: "2026-01-20" }).catch(() => {});
    incomeRan = true;
  } catch (e) {
    console.warn("  (accounting seed skipped:", e.message, ")");
  }

  console.log("✅ Seed complete:");
  console.log(`   admin login        -> username: admin       | category: Administrator | password: ${ADMIN_PASSWORD}`);
  console.log(`   accountant login   -> username: accountant  | category: Accountant    | password: ${ADMIN_PASSWORD}`);
  console.log(`   students: ${students.length}, subjects: ${subjects.length}, classes: 2, terms: 2, accounting: ${incomeRan}`);
  process.exit(0);
};

run().catch((err) => {
  console.error("❌ Seed failed:", err);
  process.exit(1);
});
