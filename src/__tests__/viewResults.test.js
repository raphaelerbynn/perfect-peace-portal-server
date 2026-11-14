// "View results" and "Enter results" send the term id as `term`; the class result queries filter
// on termId. Before the fix it was undefined and the request failed (500).
process.env.JWT_KEY = "test-secret";
process.env.NODE_ENV = "test";

import jwt from "jsonwebtoken";
import request from "supertest";

jest.mock("../services/results.js", () => {
  const actual = jest.requireActual("../services/results.js");
  return {
    __esModule: true,
    ...actual,
    getClassResult: jest.fn(async () => [{ dataValues: { studentId: 1, rawScore: 80 } }]),
    getClassMarks: jest.fn(async () => [{ studentId: 1, subjectId: 2 }]),
    getKGResultByClassAndTerm: jest.fn(async () => []),
    getOneStudentResult: jest.fn(async () => []),
    getOneStudentMarks: jest.fn(async () => []),
    getOneStudentKGResult: jest.fn(async () => []),
  };
});

const app = require("../index.js").default;
const results = require("../services/results.js");
const admin = jwt.sign({ category: "Administrator", username: "admin" }, "test-secret", { algorithm: "HS256" });

it("passes the term id to the class result queries", async () => {
  const res = await request(app).get("/student-results?class=JHS%201&term=2&year=2026").set("Authorization", `Bearer ${admin}`);
  expect(res.status).toBe(200);
  expect(res.body).toEqual([{ studentId: 1, rawScore: 80, marks: [{ studentId: 1, subjectId: 2 }] }]);
  expect(results.getClassResult).toHaveBeenCalledWith(expect.objectContaining({ class: "JHS 1", termId: "2" }));
  expect(results.getClassMarks).toHaveBeenCalledWith(expect.objectContaining({ termId: "2" }));
});

it("same for KG results", async () => {
  const res = await request(app).get("/student-kg-results?class=KG%201&term=2").set("Authorization", `Bearer ${admin}`);
  expect(res.status).toBe(200);
  expect(results.getKGResultByClassAndTerm).toHaveBeenCalledWith(expect.objectContaining({ termId: "2" }));
});

it("and to the single-pupil reads used by Enter results", async () => {
  const auth = (r) => r.set("Authorization", `Bearer ${admin}`);
  expect((await auth(request(app).get("/student-marks?studentId=5&class=JHS%201&year=2026&term=2"))).status).toBe(200);
  expect(results.getOneStudentResult).toHaveBeenCalledWith(expect.objectContaining({ studentId: "5", termId: "2" }));
  expect(results.getOneStudentMarks).toHaveBeenCalledWith(expect.objectContaining({ termId: "2" }));
  expect((await auth(request(app).get("/kg-assessment?studentId=2&class=KG%201&term=2"))).status).toBe(200);
  expect(results.getOneStudentKGResult).toHaveBeenCalledWith(expect.objectContaining({ termId: "2" }));
});
