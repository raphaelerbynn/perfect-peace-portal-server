import { Op } from "sequelize";
import sequelize from "../config/database.js";
import { Expense, Fee, Income } from "../models/index.js";
import { AppError } from "../utils/errorHandling.js";

// Postgres date-part expression (ported from MySQL YEAR()/MONTH()/DAYOFMONTH()/
// WEEK()). part ∈ YEAR|MONTH|DAY|WEEK; the column is double-quoted for Postgres.
const datePart = (part, col) => sequelize.literal(`EXTRACT(${part} FROM "${col}")`);

// Grouped time-series: SUM(sumCol) bucketed by a date part of dateCol, filtered
// to the requested year/month/week. Replaces the per-model MySQL graph builders.
// Note: EXTRACT() returns numeric, so the filter values are coerced with Number()
// (Postgres has no implicit numeric = text comparison, unlike MySQL).
const buildTimeSeries = async (Model, { groupBy, year, month, week }, { dateCol, sumCol, baseWhere = {} }) => {
  const y = Number(year), m = Number(month), w = Number(week);
  let groupExpr;
  const filters = [];

  if (groupBy === "week") {
    if (!(year && month && week)) throw new AppError("year, month and week are required", 400);
    groupExpr = datePart("DAY", dateCol);
    filters.push(
      sequelize.where(datePart("YEAR", dateCol), y),
      sequelize.where(datePart("MONTH", dateCol), m),
      sequelize.where(datePart("WEEK", dateCol), 4 * m + w),
    );
  } else if (groupBy === "month") {
    if (!(year && month)) throw new AppError("year and month are required", 400);
    groupExpr = datePart("DAY", dateCol);
    filters.push(
      sequelize.where(datePart("YEAR", dateCol), y),
      sequelize.where(datePart("MONTH", dateCol), m),
    );
  } else if (groupBy === "year") {
    if (!year) throw new AppError("year is required", 400);
    groupExpr = datePart("MONTH", dateCol);
    filters.push(sequelize.where(datePart("YEAR", dateCol), y));
  } else {
    groupExpr = datePart("YEAR", dateCol);
  }

  return await Model.findAll({
    attributes: [
      [groupExpr, "label"],
      [sequelize.fn("SUM", sequelize.col(sumCol)), "totalAmount"],
    ],
    group: groupExpr,
    where: { ...baseWhere, ...(filters.length ? { [Op.and]: filters } : {}) },
  });
};

const getExpenseGraph = (data) =>
  buildTimeSeries(Expense, data, { dateCol: "date", sumCol: "amount", baseWhere: { isDeleted: false } });


const getIncomeGraph = (data) =>
  buildTimeSeries(Income, data, { dateCol: "date", sumCol: "amount", baseWhere: { isDeleted: false } });

const getFeesGraph = (data) =>
  buildTimeSeries(Fee, data, { dateCol: "date_paid", sumCol: "paid" });

export { getExpenseGraph, getFeesGraph, getIncomeGraph };

const getProfitLoss = async (data) => {
  // If groupBy is provided, return grouped arrays using existing graph functions
  if (data?.groupBy) {
    // reuse existing graph functions which return [{ label, totalAmount }, ...]
    const _income = await getIncomeGraph(data);
    const _fees = await getFeesGraph(data);
    const _expense = await getExpenseGraph(data);

    // collect union of labels (string/number) preserving order by appearance
    const labelsSet = new Set();
    const pushLabels = (arr) => arr?.forEach((r) => labelsSet.add(String(r.label)));
    pushLabels(_income);
    pushLabels(_fees);
    pushLabels(_expense);
    const labels = Array.from(labelsSet);

    const mapByLabel = (arr) => {
      const m = new Map();
      (arr || []).forEach((r) => m.set(String(r.label), Number(r.totalAmount || 0)));
      return m;
    };

    const incMap = mapByLabel(_income);
    const feeMap = mapByLabel(_fees);
    const expMap = mapByLabel(_expense);

    const income = labels.map((l) => incMap.get(l) || 0);
    const fees = labels.map((l) => feeMap.get(l) || 0);
    const expense = labels.map((l) => expMap.get(l) || 0);
    const profit = labels.map((_, i) => (income[i] || 0) + (fees[i] || 0) - (expense[i] || 0));

    return {
      grouped: true,
      labels,
      income,
      fees,
      expense,
      profit,
    };
  }

  // fallback: totals over a date range or all
  const { startDate, endDate, all } = data || {};
  // BE-4: soft-deleted ledger rows must NOT count toward profit/loss.
  const whereIncome = { isDeleted: false };
  const whereFee = {};
  const whereExpense = { isDeleted: false };

  // `all` may arrive as a string ('true'/'false') from query params — coerce to boolean
  const allFlag = all === true || all === 'true' || all === '1' || all === 1;

  // BE-9: a single bound without the other previously fell through and summed
  // ALL records, presenting a wrong total as the answer. Require both (or `all`).
  if (!allFlag) {
    if ((startDate && !endDate) || (!startDate && endDate)) {
      throw new AppError("Both startDate and endDate are required", 400);
    }
    if (startDate && endDate) {
      whereIncome.date = { [Op.between]: [startDate, endDate] };
      // Fee model stores paid date as `date_paid` column
      whereFee.date_paid = { [Op.between]: [startDate, endDate] };
      whereExpense.date = { [Op.between]: [startDate, endDate] };
    }
  }

  // sum income amounts
  const incomeResult = await Income.findAll({
    attributes: [[sequelize.fn("SUM", sequelize.col("amount")), "total"]],
    where: whereIncome,
  });
  const incomeTotal = Number(incomeResult?.[0]?.get("total") || 0);

  // sum fees (paid)
  const feesResult = await Fee.findAll({
    attributes: [[sequelize.fn("SUM", sequelize.col("paid")), "total"]],
    where: whereFee,
  });
  const feesTotal = Number(feesResult?.[0]?.get("total") || 0);

  // sum expenses
  const expenseResult = await Expense.findAll({
    attributes: [[sequelize.fn("SUM", sequelize.col("amount")), "total"]],
    where: whereExpense,
  });
  const expenseTotal = Number(expenseResult?.[0]?.get("total") || 0);

  const profit = incomeTotal + feesTotal - expenseTotal;

  return {
    incomeTotal,
    feesTotal,
    expenseTotal,
    profit,
  };
};

export { getProfitLoss };
