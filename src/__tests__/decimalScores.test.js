// Scores accept decimals (migration 012): half marks are kept, not rounded.
jest.mock("../config/database.js", () => ({ __esModule: true, default: { literal: jest.fn((x) => x), transaction: jest.fn() } }));
jest.mock("../models/index.js", () => ({
  __esModule: true,
  KgAssessment: {}, Student: {}, StudentMarks: {}, Subject: {}, StudentResult: {},
}));
jest.mock("../services/term.js", () => ({ __esModule: true, getTerm: jest.fn() }));

import { computeMarkFields } from "../services/results.js";

const MATHS = { name: "Maths", classTotalMarks: 30, examTotalMarks: 100, classPercentage: 30, examPercentage: 70 };

it("keeps half marks and 2 decimal places in the percentages and total", () => {
  // 7.5/30 of 30% = 7.5; 48.25/100 of 70% = 33.775 -> 33.78; total 41.275 -> 41.28
  expect(computeMarkFields(MATHS, "7.5", "48.25")).toMatchObject({
    classScore: 7.5,
    examScore: 48.25,
    classScorePercentage: 7.5,
    examScorePercentage: 33.78,
    totalScore: 41.28,
  });
});

it("whole-number scores still give the same totals as before", () => {
  expect(computeMarkFields(MATHS, 20, 50)).toMatchObject({ classScorePercentage: 20, examScorePercentage: 35, totalScore: 55 });
});
