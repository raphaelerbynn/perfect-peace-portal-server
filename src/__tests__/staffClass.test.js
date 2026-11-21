// Staff page: a teacher's class comes from the class record (Class.teacher_id,
// what the Classes page shows); live leaves Teacher.class_id empty.
jest.mock("../config/database.js", () => ({ __esModule: true, default: {} }));
jest.mock("../models/index.js", () => ({
  __esModule: true,
  Class: { findAll: jest.fn() },
  Salary: {},
  Teacher: { findAll: jest.fn() },
  UserAccount: {},
}));
import { Class, Teacher } from "../models/index.js";
import { getStaff } from "../services/staff.js";

const teacher = (teacherId, class_ = null) => {
  const t = { teacherId, dataValues: { teacherId, class_ } };
  t.setDataValue = (k, v) => { t.dataValues[k] = v; };
  return t;
};

it("shows the class named on the class record, even when Teacher.class_id is empty", async () => {
  Teacher.findAll.mockResolvedValue([teacher(54), teacher(11, { name: "KG 2" }), teacher(60)]);
  Class.findAll.mockResolvedValue([{ classId: 3, name: "CLASS 6", teacherId: 54 }, { classId: 16, name: " NURSERY 2", teacherId: 11 }]);
  const [desmond, gloria, nobody] = await getStaff();
  expect(desmond.dataValues.class_).toEqual({ name: "CLASS 6", classId: 3 });
  expect(gloria.dataValues.class_).toEqual({ name: "NURSERY 2", classId: 16 }); // the class record wins
  expect(nobody.dataValues.class_).toBeNull(); // no class anywhere: unchanged
});
