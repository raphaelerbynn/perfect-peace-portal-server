import { Op } from "sequelize";
import sequelize from "../config/database.js";
import { Allowance, Deductions, EmployeeSalary, Salary, SalaryPayment, Tax, Teacher } from "../models/index.js";
import { sendSMSMessage } from "./messaging.js";
import { composeMessage } from "../utils/func.js";
import { payroll_template } from "../utils/messageTemplates.js";
import { AppError } from "../utils/errorHandling.js";

// BE-7: money is whole-cedi. Require a present, finite, non-negative INTEGER.
const validatePayAmount = (amount, label = "amount") => {
    const num = Number(amount);
    if (amount == null || amount === "" || !Number.isFinite(num)) {
        throw new AppError(`${label} is required and must be a number`, 400);
    }
    if (!Number.isInteger(num)) {
        throw new AppError(`${label} must be a whole number`, 400);
    }
    if (num < 0) {
        throw new AppError(`${label} cannot be negative`, 400);
    }
    return num;
};

const validateRows = (rows, label) => {
    if (!Array.isArray(rows)) return [];
    return rows
        .filter((r) => r && (r.title?.trim?.() || r.amount != null && r.amount !== ""))
        .map((r) => {
            if (!r.title || String(r.title).trim() === "") {
                throw new AppError(`Each ${label} needs a title`, 400);
            }
            return { title: String(r.title).trim(), amount: validatePayAmount(r.amount, `${label} amount`) };
        });
};

const sumAmount = (rows) => rows.reduce((acc, r) => acc + Number(r.amount || 0), 0);

const getSalary = async () => {
    // BE-4: exclude archived salary structures from the list.
    return await Salary.findAll({ where: { isDeleted: false } });
};

const getDeductions = async (salary_id) => {
    return await Deductions.findAll({ where: { salaryId: salary_id } });
};

const getAllowance = async (salary_id) => {
    return await Allowance.findAll({ where: { salaryId: salary_id } });
};

const getTax = async (salary_id) => {
    return await Tax.findAll({ where: { salaryId: salary_id } });
};

const getOneSalary = async (id) => {
    return await Salary.findAll({ where: { salaryId: id, isDeleted: false } });
};

const getOneDeduction = async (id) => {
    return await Deductions.findAll({ where: { salaryId: id } });
};

const getOneAllowance = async (id) => {
    return await Allowance.findAll({ where: { salaryId: id } });
};

// BE-1: authoritative pay structure for a salary, with TAX now applied:
//   net = gross + allowances − deductions − tax
// Returns null if the salary does not exist / is archived.
const getSalaryStructure = async (salaryId, transaction = null) => {
    const opts = transaction ? { transaction } : {};
    const salary = await Salary.findOne({ where: { salaryId, isDeleted: false }, ...opts });
    if (!salary) return null;

    const [allowances, deductions, taxes] = await Promise.all([
        Allowance.findAll({ where: { salaryId }, ...opts }),
        Deductions.findAll({ where: { salaryId }, ...opts }),
        Tax.findAll({ where: { salaryId }, ...opts }),
    ]);

    const gross = Number(salary.amount || 0);
    const allowancesTotal = sumAmount(allowances);
    const deductionsTotal = sumAmount(deductions);
    const taxTotal = sumAmount(taxes);
    const net = gross + allowancesTotal - deductionsTotal - taxTotal;

    return { salary, gross, allowances, deductions, taxes, allowancesTotal, deductionsTotal, taxTotal, net };
};

const getSalaryPayment = async (data) => {
    if (data.all === "true") {
        return await SalaryPayment.findAll({ order: [["datePaid", "DESC"]] });
    } else if (data.query) {
        const teachers = await Teacher.findAll({
            attributes: { exclude: ["password"] },
            where: {
                [Op.or]: [
                    { fName: { [Op.like]: `%${data.query}%` } },
                    { lName: { [Op.like]: `%${data.query}%` } },
                ],
            },
        });
        const teacherIds = teachers.map((teacher) => teacher.teacherId);
        return await SalaryPayment.findAll({
            where: { teacherId: teacherIds },
            order: [["datePaid", "DESC"]],
        });
    } else {
        let startDate;
        let endDate;
        if (data.dateStart && data.dateEnd) {
            startDate = new Date(data.dateStart).toISOString();
            endDate = new Date(data.dateEnd).toISOString();
        } else {
            const now = new Date();
            const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
            startDate = firstDayOfMonth.toISOString();
            endDate = now.toISOString();
        }
        return await SalaryPayment.findAll({
            where: {
                datePaid: {
                    [Op.gte]: new Date(startDate),
                    [Op.lte]: new Date(endDate),
                },
            },
            order: [["datePaid", "DESC"]],
        });
    }
};

const getEmployeeSalary = async () => {
    return await EmployeeSalary.findAll();
};

// BE-5/BE-6/BE-9: record one salary payment.
//   - validate amount, teacher, salary structure
//   - idempotency: reject a duplicate payment for the same staff + term + period (409)
//   - snapshot the pay structure (gross/allowances/deductions/tax/net) onto the
//     row so a later edit/delete of the live Salary can't change this payslip
//   - persist datePaid as a real Date, commit, THEN send the SMS best-effort
//     (so we never tell staff "you've been paid" for a row that failed to save)
const createSalaryPayment = async (data) => {
    const amount = validatePayAmount(data?.amount, "payment amount");
    if (data?.teacherId == null) throw new AppError("teacherId is required", 400);
    if (data?.salaryId == null) throw new AppError("salaryId is required", 400);

    const committed = await sequelize.transaction(async (t) => {
        const teacher = await Teacher.findOne({
            attributes: { exclude: ["password"] },
            where: { teacherId: data.teacherId, isDeleted: false },
            transaction: t,
        });
        if (!teacher) throw new AppError("Teacher not found", 404);

        const structure = await getSalaryStructure(data.salaryId, t);
        if (!structure) throw new AppError("Salary structure not found", 404);

        const duplicate = await SalaryPayment.findOne({
            where: { teacherId: data.teacherId, term: data.term ?? null, salaryDate: data.salaryDate ?? null },
            transaction: t,
        });
        if (duplicate) {
            throw new AppError("A salary payment for this staff and period already exists", 409);
        }

        const snapshot = JSON.stringify({
            gross: structure.gross,
            allowances: structure.allowances.map((a) => ({ title: a.title, amount: Number(a.amount || 0) })),
            deductions: structure.deductions.map((d) => ({ title: d.title, amount: Number(d.amount || 0) })),
            taxes: structure.taxes.map((x) => ({ name: x.name, amount: Number(x.amount || 0) })),
            allowancesTotal: structure.allowancesTotal,
            deductionsTotal: structure.deductionsTotal,
            taxTotal: structure.taxTotal,
            net: structure.net,
        });

        const payment = await SalaryPayment.create(
            {
                teacherId: data.teacherId,
                amount,
                salaryId: data.salaryId,
                term: data.term,
                salaryDate: data.salaryDate,
                paymentMethod: data.paymentMethod,
                amountInWords: data.amountInWords,
                datePaid: new Date(),
                salarySnapshot: snapshot,
                netAmount: structure.net,
            },
            { transaction: t }
        );

        return { payment, phone: teacher.phone, name: `${teacher.fName} ${teacher.lName}` };
    });

    // BE-6: notify AFTER the row is committed; SMS failure must not fail the payment.
    try {
        if (committed.phone) {
            await sendSMSMessage(
                composeMessage({ ...data, name: committed.name }, payroll_template),
                [committed.phone]
            );
        }
    } catch (smsError) {
        // payment saved; notification is non-critical
    }

    return committed.payment;
};

// BE-2: create a salary structure + its allowances/deductions in ONE transaction
// (was Promise.allSettled with no transaction → partial payroll reported as success).
const createFullSalary = async (data) => {
    const gross = validatePayAmount(data?.amount, "salary amount");
    const allowances = validateRows(data?.allowances, "allowance");
    const deductions = validateRows(data?.deductions, "deduction");

    return await sequelize.transaction(async (t) => {
        const salary = await Salary.create(
            { title: data?.title, rank: data?.rank, amount: gross },
            { transaction: t }
        );
        await Promise.all([
            ...allowances.map((a) =>
                Allowance.create({ salaryId: salary.salaryId, title: a.title, amount: a.amount }, { transaction: t })
            ),
            ...deductions.map((d) =>
                Deductions.create({ salaryId: salary.salaryId, title: d.title, amount: d.amount }, { transaction: t })
            ),
        ]);
        return salary;
    });
};

// BE-3: replace a salary's allowances/deductions atomically (delete + reinsert in
// ONE transaction so a failed reinsert can't leave the structure wiped).
const updateFullSalary = async (data, id) => {
    const gross = validatePayAmount(data?.amount, "salary amount");
    const allowances = validateRows(data?.allowances, "allowance");
    const deductions = validateRows(data?.deductions, "deduction");

    return await sequelize.transaction(async (t) => {
        const salary = await Salary.findOne({ where: { salaryId: id, isDeleted: false }, transaction: t });
        if (!salary) throw new AppError("Salary not found", 404);

        await Salary.update(
            { title: data?.title, rank: data?.rank, amount: gross },
            { where: { salaryId: id }, transaction: t }
        );
        await Promise.all([
            Deductions.destroy({ where: { salaryId: id }, transaction: t }),
            Allowance.destroy({ where: { salaryId: id }, transaction: t }),
        ]);
        await Promise.all([
            ...allowances.map((a) =>
                Allowance.create({ salaryId: id, title: a.title, amount: a.amount }, { transaction: t })
            ),
            ...deductions.map((d) =>
                Deductions.create({ salaryId: id, title: d.title, amount: d.amount }, { transaction: t })
            ),
        ]);
        return salary;
    });
};

const editSalary = (data, id) => {
    return Salary.update(data, { where: { salaryId: id }, raw: true });
};

// BE-4: soft-delete a salary structure (it may be referenced by historical
// payslips, which now carry their own snapshot). Archive it and null any
// Teacher.salaryId pointing at it — all in one transaction.
const removeSalary = async (id) => {
    return await sequelize.transaction(async (t) => {
        const salary = await Salary.findOne({ where: { salaryId: id, isDeleted: false }, transaction: t });
        if (!salary) throw new AppError("Salary not found", 404);
        await Teacher.update({ salaryId: null }, { where: { salaryId: id }, transaction: t });
        await Salary.update({ isDeleted: true }, { where: { salaryId: id }, transaction: t });
        return { archived: true };
    });
};

const removeDeductions = async (id, { transaction } = {}) => {
    return await Deductions.destroy({ where: { salaryId: id }, ...(transaction ? { transaction } : {}) });
};

const removeAllowance = async (id, { transaction } = {}) => {
    return await Allowance.destroy({ where: { salaryId: id }, ...(transaction ? { transaction } : {}) });
};

const removeSalaryPayment = async (id) => {
    // BE-10: 404 instead of a silent success on a missing payslip.
    const existing = await SalaryPayment.findOne({ where: { salaryPaymentId: id } });
    if (!existing) throw new AppError("Salary payment not found", 404);
    return await SalaryPayment.destroy({ where: { salaryPaymentId: id } });
};

// BE-8: validate teacher + salary exist, reject duplicate assignment, and ALSO
// set Teacher.salaryId so the assignment is visible to everything that reads
// through the Teacher↔Salary association (it previously only wrote EmployeeSalary).
const _assignSalary = async (data) => {
    if (data?.teacherId == null || data?.salaryId == null) {
        throw new AppError("teacherId and salaryId are required", 400);
    }
    return await sequelize.transaction(async (t) => {
        const teacher = await Teacher.findOne({ where: { teacherId: data.teacherId, isDeleted: false }, transaction: t });
        if (!teacher) throw new AppError("Teacher not found", 404);
        const salary = await Salary.findOne({ where: { salaryId: data.salaryId, isDeleted: false }, transaction: t });
        if (!salary) throw new AppError("Salary not found", 404);

        const existing = await EmployeeSalary.findOne({
            where: { teacherId: data.teacherId, salaryId: data.salaryId },
            transaction: t,
        });
        if (existing) throw new AppError("This salary is already assigned to this staff", 409);

        const response = await EmployeeSalary.create(
            { teacherId: data.teacherId, salaryId: data.salaryId },
            { transaction: t }
        );
        await Teacher.update({ salaryId: data.salaryId }, { where: { teacherId: data.teacherId }, transaction: t });
        return response;
    });
};

export {
    getSalary,
    getDeductions,
    getAllowance,
    getTax,
    getOneSalary,
    getOneDeduction,
    getOneAllowance,
    getSalaryStructure,
    getSalaryPayment,
    getEmployeeSalary,

    createSalaryPayment,
    createFullSalary,
    updateFullSalary,

    editSalary,

    removeSalary,
    removeDeductions,
    removeAllowance,
    removeSalaryPayment,

    _assignSalary,
};
