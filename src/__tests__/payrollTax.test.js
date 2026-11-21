// A8: taxes on a salary structure are saved with the structure (create / update),
// in the same transaction as allowances and deductions; net pay can't go below zero.
// Models are mocked, so no DB is needed.

jest.mock("../config/database.js", () => ({
  __esModule: true,
  default: { transaction: jest.fn(async (cb) => cb({ id: "t" })) },
}));

jest.mock("../services/messaging.js", () => ({
  __esModule: true,
  sendSMSMessage: jest.fn(async () => ({})),
}));

jest.mock("../models/index.js", () => {
  const rows = () => ({ findAll: jest.fn(), create: jest.fn(), destroy: jest.fn() });
  return {
    __esModule: true,
    Allowance: rows(),
    Deductions: rows(),
    Tax: rows(),
    Salary: { findOne: jest.fn(), findAll: jest.fn(), create: jest.fn(), update: jest.fn() },
    SalaryPayment: { findOne: jest.fn(), create: jest.fn() },
    EmployeeSalary: { findAll: jest.fn() },
    Teacher: { findOne: jest.fn(), update: jest.fn() },
  };
});

import { createFullSalary, updateFullSalary, getSalaryStructure } from "../services/payroll.js";
import { Allowance, Deductions, Tax, Salary } from "../models/index.js";

beforeEach(() => {
  jest.clearAllMocks();
  Salary.create.mockResolvedValue({ salaryId: 7 });
  Salary.findOne.mockResolvedValue({ salaryId: 7, amount: 1000 });
  Tax.findAll.mockResolvedValue([]);
});

const taxCreates = () => Tax.create.mock.calls.map(([row]) => row);

describe("createFullSalary with taxes", () => {
  it("saves each tax row with its name and amount, inside the transaction", async () => {
    await createFullSalary({
      title: "Teacher", amount: 1000,
      allowances: [{ title: "Transport", amount: 200 }],
      deductions: [{ title: "SSNIT", amount: 55 }],
      taxes: [{ name: "PAYE", amount: 80 }, { title: "Other levy", amount: 5 }],
    });
    expect(taxCreates()).toEqual([
      { salaryId: 7, name: "PAYE", amount: 80 },
      { salaryId: 7, name: "Other levy", amount: 5 },
    ]);
    for (const [, opts] of Tax.create.mock.calls) expect(opts.transaction).toEqual({ id: "t" });
  });

  it("drops fully blank tax rows and trims names", async () => {
    await createFullSalary({ amount: 1000, taxes: [{ name: "  PAYE ", amount: 80 }, { name: "", amount: "" }, null] });
    expect(taxCreates()).toEqual([{ salaryId: 7, name: "PAYE", amount: 80 }]);
  });

  it.each([
    [{ name: "", amount: 10 }, /needs a title/],
    [{ name: "PAYE", amount: "" }, /required/],
    [{ name: "PAYE", amount: -1 }, /negative/],
    [{ name: "PAYE", amount: 10.5 }, /whole number/],
    [{ name: "x".repeat(51), amount: 1 }, /50 characters/],
  ])("rejects a bad tax row %j", async (row, msg) => {
    await expect(createFullSalary({ amount: 1000, taxes: [row] })).rejects.toThrow(msg);
    expect(Salary.create).not.toHaveBeenCalled();
  });

  it("refuses a structure whose net pay would be below zero", async () => {
    // 1000 + 0 − 600 − 500 = −100
    await expect(createFullSalary({
      amount: 1000, deductions: [{ title: "Loan", amount: 600 }], taxes: [{ name: "PAYE", amount: 500 }],
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(Salary.create).not.toHaveBeenCalled();
  });

  it("allows net pay of exactly zero", async () => {
    await createFullSalary({ amount: 100, taxes: [{ name: "PAYE", amount: 100 }] });
    expect(Tax.create).toHaveBeenCalledTimes(1);
  });
});

describe("updateFullSalary with taxes", () => {
  it("replaces the taxes when the request carries a taxes array", async () => {
    await updateFullSalary({ amount: 1000, taxes: [{ name: "PAYE", amount: 90 }] }, 7);
    expect(Tax.destroy).toHaveBeenCalledWith({ where: { salaryId: 7 }, transaction: { id: "t" } });
    expect(taxCreates()).toEqual([{ salaryId: 7, name: "PAYE", amount: 90 }]);
  });

  it("an empty taxes array removes all taxes", async () => {
    await updateFullSalary({ amount: 1000, taxes: [] }, 7);
    expect(Tax.destroy).toHaveBeenCalled();
    expect(Tax.create).not.toHaveBeenCalled();
  });

  it("leaves taxes alone when the request has no taxes field (older clients)", async () => {
    Tax.findAll.mockResolvedValue([{ name: "PAYE", amount: 80 }]);
    await updateFullSalary({ amount: 1000, allowances: [], deductions: [] }, 7);
    expect(Tax.destroy).not.toHaveBeenCalled();
    expect(Tax.create).not.toHaveBeenCalled();
    // allowances/deductions are still replaced as before
    expect(Allowance.destroy).toHaveBeenCalled();
    expect(Deductions.destroy).toHaveBeenCalled();
  });

  it("checks net pay against the existing taxes when taxes are not sent", async () => {
    Tax.findAll.mockResolvedValue([{ name: "PAYE", amount: 300 }]);
    // lowering gross to 200 with GH₵300 tax kept → net −100
    await expect(updateFullSalary({ amount: 200 }, 7)).rejects.toMatchObject({ statusCode: 400 });
    expect(Salary.update).not.toHaveBeenCalled();
  });

  it("404s on a missing or archived structure before touching anything", async () => {
    Salary.findOne.mockResolvedValue(null);
    await expect(updateFullSalary({ amount: 1000, taxes: [] }, 99)).rejects.toMatchObject({ statusCode: 404 });
    expect(Tax.destroy).not.toHaveBeenCalled();
  });
});

describe("getSalaryStructure inside a transaction", () => {
  it("reads allowances, deductions and taxes one at a time (shared connection)", async () => {
    let inFlight = 0, maxInFlight = 0;
    const slow = (val) => async () => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--; return val;
    };
    Allowance.findAll.mockImplementation(slow([{ amount: 200 }]));
    Deductions.findAll.mockImplementation(slow([{ amount: 50 }]));
    Tax.findAll.mockImplementation(slow([{ name: "PAYE", amount: 100 }]));
    const s = await getSalaryStructure(7, { id: "t" });
    expect(maxInFlight).toBe(1);
    expect(s.net).toBe(1050);
    expect(s.taxTotal).toBe(100);
  });
});
