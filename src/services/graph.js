import { Op } from "sequelize";
import sequelize from "../config/database.js";
import { Expense, Fee, Income } from "../models/index.js";
import { AppError } from "../utils/errorHandling.js";

const getExpenseGraph = async (data) => {
  let groupFunction;
  const { groupBy, year, month, week } = data;
  if (groupBy === "week") {
    groupFunction = sequelize.literal("DAYOFMONTH(date)");
    if (year && month && week) {
      return await Expense.findAll({
        attributes: [
          [groupFunction, "label"],
          [sequelize.fn("SUM", sequelize.col("amount")), "totalAmount"],
        ],
        group: groupFunction,
        where: {
          isDeleted: false,
          [Op.and]: [
            sequelize.where(sequelize.fn("YEAR", sequelize.col("date")), year),
            sequelize.where(sequelize.fn("MONTH", sequelize.col("date")), month),
            sequelize.where(sequelize.literal(`WEEK(date)`), 4 * Number(month) + Number(week)),
          ],
        },
      });
    } else {
      throw new AppError("year (and month/week for that grouping) is required", 400);
    }
  } else if (groupBy === "month") {
    groupFunction = sequelize.literal("DAYOFMONTH(date)");
    if (year && month) {
      return await Expense.findAll({
        attributes: [
          [groupFunction, "label"],
          [sequelize.fn("SUM", sequelize.col("amount")), "totalAmount"],
        ],
        group: groupFunction,
        where: {
          isDeleted: false,
          [Op.and]: [
            sequelize.where(sequelize.fn("YEAR", sequelize.col("date")), year),
            sequelize.where(sequelize.fn("MONTH", sequelize.col("date")), month),
          ],
        },
      });
    } else {
      throw new AppError("year (and month/week for that grouping) is required", 400);
    }
  } else if (groupBy === "year") {
    groupFunction = sequelize.literal("MONTH(date)");
    if (year) {
      return await Expense.findAll({
        attributes: [
          [groupFunction, "label"],
          [sequelize.fn("SUM", sequelize.col("amount")), "totalAmount"],
        ],
        group: groupFunction,
        where: {
          isDeleted: false,
          [Op.and]: [
            sequelize.where(sequelize.fn("YEAR", sequelize.col("date")), year),
          ],
        },
      });
    } else {
      throw new AppError("year (and month/week for that grouping) is required", 400);
    }
  } else {
    groupFunction = sequelize.literal("YEAR(date)");
    return await Expense.findAll({
      attributes: [
        [groupFunction, "label"],
        [sequelize.fn("SUM", sequelize.col("amount")), "totalAmount"],
      ],
      group: groupFunction,
      where: { isDeleted: false },
    });
  }
};


const getIncomeGraph = async (data) => {
  let groupFunction;
  const { groupBy, year, month, week } = data;
  if (groupBy === "week") {
    groupFunction = sequelize.literal("DAYOFMONTH(date)");
    if (year && month && week) {
      return await Income.findAll({
        attributes: [
          [groupFunction, "label"],
          [sequelize.fn("SUM", sequelize.col("amount")), "totalAmount"],
        ],
        group: groupFunction,
        where: {
          isDeleted: false,
          [Op.and]: [
            sequelize.where(sequelize.fn("YEAR", sequelize.col("date")), year),
            sequelize.where(sequelize.fn("MONTH", sequelize.col("date")), month),
            sequelize.where(sequelize.literal(`WEEK(date)`), 4 * Number(month) + Number(week)),
          ],
        },
      });
    } else {
      throw new AppError("year (and month/week for that grouping) is required", 400);
    }
  } else if (groupBy === "month") {
    groupFunction = sequelize.literal("DAYOFMONTH(date)");
    if (year && month) {
      return await Income.findAll({
        attributes: [
          [groupFunction, "label"],
          [sequelize.fn("SUM", sequelize.col("amount")), "totalAmount"],
        ],
        group: groupFunction,
        where: {
          isDeleted: false,
          [Op.and]: [
            sequelize.where(sequelize.fn("YEAR", sequelize.col("date")), year),
            sequelize.where(sequelize.fn("MONTH", sequelize.col("date")), month),
          ],
        },
      });
    } else {
      throw new AppError("year (and month/week for that grouping) is required", 400);
    }
  } else if (groupBy === "year") {
    groupFunction = sequelize.literal("MONTH(date)");
    if (year) {
      return await Income.findAll({
        attributes: [
          [groupFunction, "label"],
          [sequelize.fn("SUM", sequelize.col("amount")), "totalAmount"],
        ],
        group: groupFunction,
        where: {
          isDeleted: false,
          [Op.and]: [
            sequelize.where(sequelize.fn("YEAR", sequelize.col("date")), year),
          ],
        },
      });
    } else {
      throw new AppError("year (and month/week for that grouping) is required", 400);
    }
  } else {
    groupFunction = sequelize.literal("YEAR(date)");
    return await Income.findAll({
      attributes: [
        [groupFunction, "label"],
        [sequelize.fn("SUM", sequelize.col("amount")), "totalAmount"],
      ],
      group: groupFunction,
      where: { isDeleted: false },
    });
  }
};

const getFeesGraph = async (data) => {
  let groupFunction;
  const { groupBy, year, month, week } = data;
  if (groupBy === "week") {
    groupFunction = sequelize.literal("DAYOFMONTH(date_paid)");
    if (year && month && week) {
      return await Fee.findAll({
        attributes: [
          [groupFunction, "label"],
          [sequelize.fn("SUM", sequelize.col("paid")), "totalAmount"],
        ],
        group: groupFunction,
        where: {
          [Op.and]: [
            sequelize.where(sequelize.fn("YEAR", sequelize.col("date_paid")), year),
            sequelize.where(
              sequelize.fn("MONTH", sequelize.col("date_paid")),
              month
            ),
            sequelize.where(
              sequelize.literal(`DAYOFMONTH(date_paid)`),
              4 * Number(month) + Number(week)
            ),
          ],
        },
      });
    } else {
      throw new AppError("year (and month/week for that grouping) is required", 400);
    }
  } else if (groupBy === "month") {
    groupFunction = sequelize.literal("DAY(date_paid)");
    if (year && month) {
      return await Fee.findAll({
        attributes: [
          [groupFunction, "label"],
          [sequelize.fn("SUM", sequelize.col("paid")), "totalAmount"],
        ],
        group: groupFunction,
        where: {
          [Op.and]: [
            sequelize.where(sequelize.fn("YEAR", sequelize.col("date_paid")), year),
            sequelize.where(
              sequelize.fn("MONTH", sequelize.col("date_paid")),
              month
            ),
          ],
        },
      });
    } else {
      throw new AppError("year (and month/week for that grouping) is required", 400);
    }
  } else if (groupBy === "year") {
    groupFunction = sequelize.literal("MONTH(date_paid)");
    if (year) {
      return await Fee.findAll({
        attributes: [
          [groupFunction, "label"],
          [sequelize.fn("SUM", sequelize.col("paid")), "totalAmount"],
        ],
        group: groupFunction,
        where: {
          [Op.and]: [
            sequelize.where(sequelize.fn("YEAR", sequelize.col("date_paid")), year),
          ],
        },
      });
    } else {
      throw new AppError("year (and month/week for that grouping) is required", 400);
    }
  } else {
    groupFunction = sequelize.literal("YEAR(date_paid)");
    const response = Fee.findAll({
      attributes: [
        [groupFunction, "label"],
        [sequelize.fn("SUM", sequelize.col("paid")), "totalAmount"],
      ],
      group: groupFunction,
    });
    return response
  }
};

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
