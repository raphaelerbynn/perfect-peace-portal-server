import { AccountCategory, BusFee, Expense, ExtraClasses, FeedingFee, Income } from "../models/index.js";
import { Op } from "sequelize";
import { AppError } from "../utils/errorHandling.js";

// BE-3: money is whole-cedi (DECIMAL(18,0)). Require a present, finite, NON-
// NEGATIVE INTEGER amount so nothing is silently truncated or flips a total.
const validateLedgerAmount = (amount) => {
  const num = Number(amount);
  if (amount == null || amount === "" || !Number.isFinite(num)) {
    throw new AppError("amount is required and must be a number", 400);
  }
  if (!Number.isInteger(num)) {
    throw new AppError("amount must be a whole number (no fractional cedis)", 400);
  }
  if (num <= 0) {
    throw new AppError("amount must be greater than 0", 400);
  }
  return num;
};

// BE-3: a ledger row needs a valid date.
const validateLedgerDate = (date) => {
  if (!date) throw new AppError("date is required", 400);
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) throw new AppError("date is invalid", 400);
  return d.toISOString().slice(0, 10);
};

// BE-1/BE-2: build a parameterized inclusive date-range filter (no string
// interpolation into SQL). Returns a Sequelize `where.date` clause or null when
// no range was supplied. Throws 400 if exactly one bound is present/invalid.
const buildDateWhere = (data) => {
  if (data.all === "true" || (!data.startDate && !data.endDate)) return null;
  if (!data.startDate || !data.endDate) {
    throw new AppError("Both startDate and endDate are required", 400);
  }
  const start = new Date(data.startDate);
  const end = new Date(data.endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new AppError("Valid startDate and endDate are required", 400);
  }
  return { [Op.between]: [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)] };
};

const createFeeding = async (data) => {
  const response = await FeedingFee.create({
    teacher: data?.teacher,
    class: data?.class,
    amount: data?.amount,
    date: data?.date,
  });

  return response;
};

const createExtraClasses = async (data) => {
  const response = await ExtraClasses.create({
    teacher: data?.teacher,
    class: data?.class,
    amount: data?.amount,
    date: data?.date,
  });

  return response;
};

const createBusFee = async (data) => {
  const response = await BusFee.create({
    teacher: data?.teacher,
    class: data?.class,
    amount: data?.amount,
    date: data?.date,
  });

  return response;
};

const getFeeding = async (data) => {
  if (data.all === "true" || !data.startDate) {
    return await FeedingFee.findAll();
  }
  // Postgres: parameterized inclusive range (replaces MySQL CONVERT(...) literal).
  const dateWhere = buildDateWhere(data);
  return await FeedingFee.findAll({
    where: dateWhere ? { date: dateWhere } : {},
  });
};

// BE-1/BE-2/BE-4: parameterized inclusive range (no SQL string interpolation;
// the old `literal(CONVERT('${d}'...))` was an injection risk AND the single-day
// branch used a malformed `{date:{date:...}}` clause that matched nothing).
// Archived (soft-deleted) rows are excluded from every read.
const getExpense = async (data) => {
  if (!data.startDate || data.all === "true") {
    return await getAllExpense();
  }
  const dateWhere = buildDateWhere(data);
  return await Expense.findAll({
    where: { isDeleted: false, ...(dateWhere ? { date: dateWhere } : {}) },
    include: [{ model: AccountCategory, as: "accountCategory", attributes: ["name"] }],
    order: [['expenseId', 'DESC']],
  });
};

const getIncome = async (data) => {
  if (!data.startDate || data.all === "true") {
    return await getAllIncome();
  }
  const dateWhere = buildDateWhere(data);
  return await Income.findAll({
    where: { isDeleted: false, ...(dateWhere ? { date: dateWhere } : {}) },
    include: [{ model: AccountCategory, as: "accountCategory", attributes: ["name"] }],
    order: [['incomeId', 'DESC']],
  });
};

const getExtraClasses = async (data) => {
  if (data.all === "true" || !data.startDate) {
    return await ExtraClasses.findAll();
  }
  const dateWhere = buildDateWhere(data);
  return await ExtraClasses.findAll({
    where: dateWhere ? { date: dateWhere } : {},
  });
};

const getBusFee = async (data) => {
  if (data.all === "true" || !data.startDate) {
    return await BusFee.findAll();
  }
  const dateWhere = buildDateWhere(data);
  return await BusFee.findAll({
    where: dateWhere ? { date: dateWhere } : {},
  });
};

const removeFeeding = async (id) => {
  const response = await FeedingFee.destroy({
    where: {
      feeding: id,
    },
  });
  return response;
};

const removeExtraClasses = async (id) => {
  const response = await ExtraClasses.destroy({
    where: {
      extraClassesId: id,
    },
  });
  return response;
};

const removeBusFee = async (id) => {
  const response = await BusFee.destroy({
    where: {
      busFeeId: id,
    },
  });
  return response;
};


// new architecture

const ALLOWED_CATEGORY_TYPES = ["income", "expense"];

// BE-7: confirm a referenced account category exists (and optionally matches the
// expected income/expense type) before booking a ledger row against it.
const ensureCategory = async (accountCategoryId, expectedType) => {
  if (accountCategoryId == null || accountCategoryId === "") {
    throw new AppError("accountCategoryId is required", 400);
  }
  const category = await AccountCategory.findByPk(accountCategoryId);
  if (!category) {
    throw new AppError("Invalid account category", 400);
  }
  if (expectedType && category.type && category.type !== expectedType) {
    throw new AppError(`Category is not an ${expectedType} category`, 400);
  }
  return category;
};

//account category
export const getAccountCategory = async (type) => {
  // BE-11: reject an unrecognized type rather than silently returning [].
  if (type && !ALLOWED_CATEGORY_TYPES.includes(type)) {
    throw new AppError("type must be 'income' or 'expense'", 400);
  }
  const data = type ? await AccountCategory.findAll({
      where: { type },
      raw: true
   }) : await AccountCategory.findAll({ raw: true });

   return data
};

export const createAccountCategory = async (data) => {
  if (!data?.name || String(data.name).trim() === "") {
    throw new AppError("Category name is required", 400);
  }
  if (data?.type && !ALLOWED_CATEGORY_TYPES.includes(data.type)) {
    throw new AppError("type must be 'income' or 'expense'", 400);
  }
  return await AccountCategory.create(data);
};

export const removeAccountCategory = async (accountCategoryId) => {
  // BE-5: refuse to delete a category that still has income/expense rows — that
  // would orphan them (their `include` would resolve to a null category and
  // by-category reporting would break). 409 instead of silent orphaning.
  const existing = await AccountCategory.findByPk(accountCategoryId);
  if (!existing) {
    throw new AppError("Account category not found", 404);
  }
  const [incomeCount, expenseCount] = await Promise.all([
    Income.count({ where: { accountCategoryId, isDeleted: false } }),
    Expense.count({ where: { accountCategoryId, isDeleted: false } }),
  ]);
  if (incomeCount + expenseCount > 0) {
    throw new AppError(
      "Cannot delete a category that is in use by income/expense records",
      409
    );
  }
  return await AccountCategory.destroy({
    where: { accountCategoryId },
  });
};

//expense
export const getAllExpense = async () => {
  return await Expense.findAll({
    where: { isDeleted: false },
    include: [{ model: AccountCategory, as: "accountCategory", attributes: ["name"] }],
    order: [['expenseId', 'DESC']],
  });
};

export const createExpense = async (data) => {
  // BE-3/BE-7: validate amount + date, verify the category exists.
  const amount = validateLedgerAmount(data?.amount);
  const date = validateLedgerDate(data?.date);
  await ensureCategory(data?.accountCategoryId, "expense");
  return await Expense.create({
    expense: data?.expense,
    amount,
    date,
    accountCategoryId: data?.accountCategoryId,
  });
};

export const removeExpense = async (expenseId) => {
  // BE-4/BE-6: soft-delete (archive) + 404 on a missing/already-archived row.
  const existing = await Expense.findOne({ where: { expenseId, isDeleted: false } });
  if (!existing) {
    throw new AppError("Expense record not found", 404);
  }
  return await Expense.update({ isDeleted: true }, { where: { expenseId } });
};

//income
export const getAllIncome = async () => {
  return await Income.findAll({
    where: { isDeleted: false },
    include: [{ model: AccountCategory, as: "accountCategory", attributes: ["name"] }],
    order: [['incomeId', 'DESC']],
  });
};

export const createIncome = async (data) => {
  const amount = validateLedgerAmount(data?.amount);
  const date = validateLedgerDate(data?.date);
  await ensureCategory(data?.accountCategoryId, "income");
  return await Income.create({
    income: data?.income,
    amount,
    date,
    accountCategoryId: data?.accountCategoryId,
  });
};

export const removeIncome = async (incomeId) => {
  const existing = await Income.findOne({ where: { incomeId, isDeleted: false } });
  if (!existing) {
    throw new AppError("Income record not found", 404);
  }
  return await Income.update({ isDeleted: true }, { where: { incomeId } });
};



export {
  createFeeding,
  createExtraClasses,
  createBusFee,
  getFeeding,
  getExpense,
  getIncome,
  getExtraClasses,
  getBusFee,
  removeFeeding,
  removeExtraClasses,
  removeBusFee,
};
