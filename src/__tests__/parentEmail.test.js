// B16: the parent's email on the pupil form (for email notifications).
jest.mock("../config/database.js", () => ({ __esModule: true, default: { transaction: jest.fn(), query: jest.fn() } }));
jest.mock("../models/index.js", () => ({ __esModule: true }));
jest.mock("../services/school.js", () => ({ __esModule: true, getSchoolSettings: jest.fn() }));

import { cleanParentEmail } from "../services/test.js";

it("optional, trimmed, validated; not sent = leave as it is; empty = remove", () => {
  expect(cleanParentEmail(undefined)).toBeUndefined();
  expect(cleanParentEmail("")).toBeNull();
  expect(cleanParentEmail(null)).toBeNull();
  expect(cleanParentEmail("  mum@example.com ")).toBe("mum@example.com");
  expect(() => cleanParentEmail("not-an-email")).toThrow(/valid email/);
  expect(() => cleanParentEmail(`${"a".repeat(45)}@example.com`)).toThrow(/50 characters/);
});
