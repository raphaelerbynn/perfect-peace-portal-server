// Feature #12 (Payroll): net pay must subtract TAX as well as deductions:
//   net = gross + allowances − deductions − tax
// We mock the Sequelize models so no DB is required.

jest.mock("../config/database.js", () => ({
  __esModule: true,
  default: { transaction: jest.fn(async (cb) => cb({})) },
}));

jest.mock("../services/messaging.js", () => ({
  __esModule: true,
  sendSMSMessage: jest.fn(async () => ({})),
}));

jest.mock("../models/index.js", () => ({
  __esModule: true,
  Allowance: { findAll: jest.fn() },
  Deductions: { findAll: jest.fn() },
  Tax: { findAll: jest.fn() },
  Salary: { findOne: jest.fn(), findAll: jest.fn() },
  SalaryPayment: { findOne: jest.fn(), create: jest.fn() },
  EmployeeSalary: { findAll: jest.fn() },
  Teacher: { findOne: jest.fn() },
}));

import { getSalaryStructure } from "../services/payroll.js";
import { Allowance, Deductions, Tax, Salary } from "../models/index.js";

describe("getSalaryStructure (net = gross + allowances − deductions − tax)", () => {
  it("subtracts tax from net pay", async () => {
    Salary.findOne.mockResolvedValue({ salaryId: 1, amount: 1000 });
    Allowance.findAll.mockResolvedValue([{ title: "Transport", amount: 200 }]);
    Deductions.findAll.mockResolvedValue([{ title: "SSNIT", amount: 50 }]);
    Tax.findAll.mockResolvedValue([{ name: "PAYE", amount: 100 }]);

    const s = await getSalaryStructure(1);
    expect(s.gross).toBe(1000);
    expect(s.allowancesTotal).toBe(200);
    expect(s.deductionsTotal).toBe(50);
    expect(s.taxTotal).toBe(100);
    // 1000 + 200 − 50 − 100 = 1050
    expect(s.net).toBe(1050);
  });

  it("treats empty allowance/deduction/tax sets as zero", async () => {
    Salary.findOne.mockResolvedValue({ salaryId: 2, amount: 800 });
    Allowance.findAll.mockResolvedValue([]);
    Deductions.findAll.mockResolvedValue([]);
    Tax.findAll.mockResolvedValue([]);

    const s = await getSalaryStructure(2);
    expect(s.net).toBe(800);
  });

  it("returns null for an archived / missing salary structure", async () => {
    Salary.findOne.mockResolvedValue(null);
    expect(await getSalaryStructure(999)).toBeNull();
  });
});
