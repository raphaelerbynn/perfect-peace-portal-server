// B5: closing a term no longer moves pupils; after term 3 it reports how many
// classes still need promotion.
jest.mock("../config/database.js", () => ({ __esModule: true, default: { transaction: jest.fn() } }));
jest.mock("../models/index.js", () => ({ __esModule: true, Term: { findOne: jest.fn(), update: jest.fn() } }));
jest.mock("../services/promotion.js", () => ({ __esModule: true, getStatus: jest.fn() }));

import { Term } from "../models/index.js";
import { getStatus } from "../services/promotion.js";
import { inactivateTerms } from "../services/term.js";

beforeEach(() => jest.resetAllMocks());

it("term 3: closes and reports classes still to promote", async () => {
  Term.findOne.mockResolvedValue({ termId: 9, term: "3", active: true });
  getStatus.mockResolvedValue({ pendingClasses: 2 });
  const out = await inactivateTerms();
  expect(Term.update).toHaveBeenCalledWith({ active: false }, { where: {} });
  expect(out).toEqual({ termId: 9, pendingClasses: 2, message: expect.stringContaining("2 classes still need promotion") });
});

it("terms 1 and 2: just closes", async () => {
  Term.findOne.mockResolvedValue({ termId: 8, term: "2", active: true });
  expect(await inactivateTerms()).toEqual({ termId: 8, pendingClasses: 0, message: "Term closed" });
  expect(getStatus).not.toHaveBeenCalled();
});

it("409 when no term is open", async () => {
  Term.findOne.mockResolvedValue(null);
  await expect(inactivateTerms()).rejects.toMatchObject({ statusCode: 409 });
});
