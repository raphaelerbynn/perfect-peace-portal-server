// Closing a term failed on Postgres: the roll-up selected non-grouped columns
// (class, entered_by…), which MySQL tolerated and Postgres refuses.
jest.mock("../config/database.js", () => ({
  __esModule: true,
  default: { transaction: jest.fn(async (cb) => cb({})), fn: jest.fn((...a) => ({ fn: a })), literal: jest.fn((x) => x), col: jest.fn((x) => x) },
}));
jest.mock("../models/index.js", () => ({
  __esModule: true,
  Attendance: { findAll: jest.fn(async () => []), destroy: jest.fn() },
  TotalAttendance: { upsert: jest.fn() },
  Student: { findAll: jest.fn(async () => []) },
  Class: {},
}));
jest.mock("../services/term.js", () => ({ __esModule: true, getTerm: jest.fn(async () => ({ termId: 2 })) }));

import { Attendance } from "../models/index.js";
import { addTermAttendance } from "../services/attendance.js";

it("selects only the grouped columns and aggregates", async () => {
  await addTermAttendance();
  const opts = Attendance.findAll.mock.calls[0][0];
  expect(Array.isArray(opts.attributes)).toBe(true);
  const plain = opts.attributes.filter((a) => typeof a === "string");
  expect(plain).toEqual(["studentId", "termId"]);
  expect(opts.group).toEqual(["studentId", "termId"]);
});
