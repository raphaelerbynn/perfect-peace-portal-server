// B10 review fixes in the staff and class services:
//   - changing which teacher a class is linked to (class edit/create, staff
//     edit/create) needs academics.all_classes: that link is what limits a
//     login without it to "its own class";
//   - staff bank / payroll fields need staff.view_sensitive (a filled value is
//     refused with a 403 naming it; blanks from the form are ignored);
//   - archiving a staff member can't disable an office login stronger than the
//     caller.
// Models mocked; no database.
jest.mock("../config/database.js", () => ({
  __esModule: true,
  default: { transaction: async (fn) => fn({ LOCK: { UPDATE: "UPDATE" } }), query: jest.fn(async () => [[]]) },
}));
jest.mock("../services/fee.js", () => ({ __esModule: true, recomputeStudentOwing: jest.fn() }));
jest.mock("../models/index.js", () => {
  const model = () => ({
    findOne: jest.fn(async () => null),
    findAll: jest.fn(async () => []),
    findByPk: jest.fn(async () => null),
    update: jest.fn(async () => [1]),
    create: jest.fn(async (v) => ({ ...v, classId: 50, dataValues: { teacher_id: 77 } })),
    count: jest.fn(async () => 0),
    destroy: jest.fn(async () => 1),
  });
  return {
    __esModule: true,
    Class: model(), ClassFee: model(), Student: model(), Teacher: model(), Term: model(), TeachingAssignment: model(),
    Salary: model(), UserAccount: model(), Role: model(), RolePermission: model(),
  };
});

import { Class, Teacher, UserAccount } from "../models/index.js";
import { createClass, editClass } from "../services/classes.js";
import { createStaff, editStaff, removeStaff } from "../services/staff.js";
import { officeUser } from "../testSupport/officeUser.js";

const admin = officeUser("Administrator", { username: "admin" });
// A school role that may edit classes and staff but works on its own class only.
const deputy = officeUser("Deputy", { username: "deputy", teacherId: 9 }, ["classes.manage", "staff.edit", "results.view"]);
// Every class, but not the payroll fields.
const registrar = officeUser("Registrar", { username: "reg" }, ["staff.edit", "academics.all_classes"]);

const staffBody = { fName: "Ama", lName: "Mensah", gender: "female", phone: "0241234567", category: "teaching" };

beforeEach(() => {
  jest.clearAllMocks();
  Teacher.findOne.mockResolvedValue(null);
  Class.findOne.mockResolvedValue(null);
});

describe("class <-> teacher link needs academics.all_classes", () => {
  it("class edit: another teacher refused without it, allowed with it, unchanged teacher fine", async () => {
    Class.findOne.mockImplementation(async ({ where }) => (where?.classId === "3" ? { classId: 3, name: "JHS 1", teacherId: 4 } : null));
    await expect(editClass({ name: "JHS 1", teacher_id: 9 }, "3", deputy)).rejects.toMatchObject({ statusCode: 403 });
    await expect(editClass({ name: "JHS 1" }, "3", deputy)).rejects.toMatchObject({ statusCode: 403 }); // absent = unlink
    expect(Class.update).not.toHaveBeenCalled();
    await expect(editClass({ name: "JHS 1", teacher_id: 4 }, "3", deputy)).resolves.toBeDefined();
    await expect(editClass({ name: "JHS 1", teacher_id: 9 }, "3", admin)).resolves.toBeDefined();
  });

  it("class create with a teacher refused without it", async () => {
    await expect(createClass({ name: "JHS 9", teacher_id: 9 }, deputy)).rejects.toMatchObject({ statusCode: 403 });
    await expect(createClass({ name: "JHS 9" }, deputy)).resolves.toBeDefined();
    await expect(createClass({ name: "JHS 9", teacher_id: 9 }, admin)).resolves.toBeDefined();
  });

  it("staff edit: a different class refused without it; the same class fine", async () => {
    Teacher.findOne.mockResolvedValue({ teacherId: 9, classId: null });
    Class.findOne.mockImplementation(async ({ where }) => (where?.teacherId === "9" ? { classId: 1 } : null));
    await expect(editStaff({ class: 3 }, "9", deputy)).rejects.toMatchObject({ statusCode: 403 });
    await expect(editStaff({ class: "" }, "9", deputy)).rejects.toMatchObject({ statusCode: 403 });
    expect(Teacher.update).not.toHaveBeenCalled();
    await expect(editStaff({ class: 1, phone: "0241234567" }, "9", deputy)).resolves.toBeDefined();
    await expect(editStaff({ class: 3 }, "9", admin)).resolves.toBeDefined();
  });

  it("staff create with a class refused without it", async () => {
    await expect(createStaff({ ...staffBody, class: 3 }, deputy)).rejects.toMatchObject({ statusCode: 403 });
    await expect(createStaff({ ...staffBody, class: null }, deputy)).resolves.toBeDefined();
  });
});

describe("staff bank and payroll fields need staff.view_sensitive", () => {
  it("a filled value is refused, naming the field", async () => {
    Teacher.findOne.mockResolvedValue({ teacherId: 9 });
    await expect(editStaff({ bank: "GCB" }, "9", registrar)).rejects.toMatchObject({ statusCode: 403, message: expect.stringContaining("bank") });
    await expect(editStaff({ ssnit: "C123", salaryId: 2 }, "9", registrar)).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringMatching(/SSNIT number.*rank/),
    });
    await expect(createStaff({ ...staffBody, tin: "P001" }, registrar)).rejects.toMatchObject({ statusCode: 403, message: expect.stringContaining("TIN") });
    expect(Teacher.update).not.toHaveBeenCalled();
    expect(Teacher.create).not.toHaveBeenCalled();
  });

  it("blank values from the form are ignored, never written (they'd wipe the stored ones)", async () => {
    Teacher.findOne.mockResolvedValue({ teacherId: 9 });
    await editStaff({ phone: "0241234567", bank: "", account: "", ssnit: "", tin: "", salaryId: null }, "9", registrar);
    const written = Teacher.update.mock.calls[0][0];
    for (const col of ["bank", "accountNumber", "ssnitNumber", "tinNumber", "salaryId"]) expect(written).not.toHaveProperty(col);
    expect(written.phone).toBe("0241234567");
  });

  it("with staff.view_sensitive (the Administrator) they are written as before", async () => {
    Teacher.findOne.mockResolvedValue({ teacherId: 9 });
    await editStaff({ bank: "GCB", account: "123", salaryId: 2 }, "9", admin);
    expect(Teacher.update.mock.calls[0][0]).toMatchObject({ bank: "GCB", accountNumber: "123", salaryId: 2 });
  });
});

describe("archiving staff can't disable a stronger login", () => {
  const hr = officeUser("HR", { username: "hr" }, ["staff.delete", "staff.view", "roles.manage"]);

  it("refused when the linked login's role holds more than the caller", async () => {
    Teacher.findOne.mockResolvedValue({ teacherId: 5 });
    UserAccount.findAll.mockResolvedValue([{ username: "bursar", roleId: 3, category: "Accountant", isDeleted: false }]);
    UserAccount.count.mockResolvedValue(1);
    await expect(removeStaff("5", hr)).rejects.toMatchObject({ statusCode: 403 });
    expect(UserAccount.update).not.toHaveBeenCalled();
  });

  it("allowed for the Administrator, and for a staff member without a login", async () => {
    Teacher.findOne.mockResolvedValue({ teacherId: 5 });
    UserAccount.findAll.mockResolvedValue([{ username: "bursar", roleId: 3, category: "Accountant", isDeleted: false }]);
    await expect(removeStaff("5", admin)).resolves.toMatchObject({ archived: true });
    UserAccount.findAll.mockResolvedValue([]);
    await expect(removeStaff("5", hr)).resolves.toMatchObject({ archived: true });
  });
});
