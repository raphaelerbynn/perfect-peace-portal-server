// B4: a report card's attendance. Closed term = the rolled-up totals; open
// term = counted live from the daily register.
jest.mock("../config/database.js", () => ({ __esModule: true, default: {} }));
jest.mock("../models/index.js", () => ({
  __esModule: true,
  Attendance: { findAll: jest.fn() },
  Class: {},
  Student: {},
  TotalAttendance: { findOne: jest.fn() },
}));
jest.mock("../services/term.js", () => ({ __esModule: true, getTerm: jest.fn() }));

import { Attendance, TotalAttendance } from "../models/index.js";
import { getTotalStudentAttendance } from "../services/attendance.js";

beforeEach(() => jest.resetAllMocks());

it("uses the closed-term totals when they exist", async () => {
  TotalAttendance.findOne.mockResolvedValue({ present: 40, sick: 1, attendance: 45 });
  expect(await getTotalStudentAttendance({ studentId: 1, termId: 2 })).toEqual({ present: 40, sick: 1, attendance: 45 });
  expect(Attendance.findAll).not.toHaveBeenCalled();
});

it("otherwise counts the register so far", async () => {
  TotalAttendance.findOne.mockResolvedValue(null);
  Attendance.findAll.mockResolvedValue([{ status: "Present   " }, { status: "Present" }, { status: "Sick      " }, { status: "Absent    " }]); // CHAR(10) padding
  expect(await getTotalStudentAttendance({ studentId: "1", termId: "2" })).toEqual({
    studentId: 1, termId: 2, present: 2, sick: 1, attendance: 4,
  });
});

it("null when nothing was taken", async () => {
  TotalAttendance.findOne.mockResolvedValue(null);
  Attendance.findAll.mockResolvedValue([]);
  expect(await getTotalStudentAttendance({ studentId: 1, termId: 2 })).toBeNull();
});

it("400 without ids", async () => {
  await expect(getTotalStudentAttendance({ studentId: 1 })).rejects.toMatchObject({ statusCode: 400 });
});
