// Review finding: a single pupil's position was ranked over just their own row
// (always 1st). It now comes from the whole class's ranking.
jest.mock("../config/database.js", () => ({ __esModule: true, default: { literal: jest.fn((x) => x), transaction: jest.fn() } }));
jest.mock("../models/index.js", () => ({
  __esModule: true,
  KgAssessment: {}, Student: {}, StudentMarks: {}, Subject: {},
  StudentResult: { findAll: jest.fn() },
}));
jest.mock("../services/term.js", () => ({ __esModule: true, getTerm: jest.fn() }));

import { StudentResult } from "../models/index.js";
import { getOneStudentResult } from "../services/results.js";

it("ranks across the class, then picks the pupil", async () => {
  StudentResult.findAll.mockResolvedValue([
    { studentId: 1, position: "1", dataValues: { studentId: 1 } },
    { studentId: 4, position: "2", dataValues: { studentId: 4 } },
  ]);
  const out = await getOneStudentResult({ class: "JHS 1", termId: 2, studentId: "4" });
  expect(out).toEqual([expect.objectContaining({ studentId: 4, position: "2" })]);
  expect(StudentResult.findAll.mock.calls[0][0].where).toEqual({ class: "JHS 1", termId: 2 }); // no studentId filter
});
