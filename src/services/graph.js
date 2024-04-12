import { Op } from "sequelize";
import sequelize from "../config/database.js";
import { BusFee, Expense, ExtraClasses, Fee, FeedingFee } from "../models/index.js";

const getExpenseGraph = async (data) => {
  let groupFunction;
  const { groupBy, year, month, week } = data;
  if (groupBy === "week") {
    groupFunction = sequelize.literal("DATEPART(DAY, date)");
    if (year && month && week) {
      return await Expense.findAll({
        attributes: [
          [groupFunction, "label"],
          [sequelize.fn("SUM", sequelize.col("amount")), "totalAmount"],
        ],
        group: groupFunction,
        where: {
          [Op.and]: [
            sequelize.where(sequelize.fn("YEAR", sequelize.col("date")), year),
            sequelize.where(
              sequelize.fn("MONTH", sequelize.col("date")),
              month
            ),
            sequelize.where(
              sequelize.literal(`DATEPART(WEEK, date)`),
              4 * Number(month) + Number(week)
            ),
          ],
        },
      });
    } else {
      throw new Error("Year missing");
    }
  } else if (groupBy === "month") {
    groupFunction = sequelize.literal("DATEPART(DAY, date)");
    if (year && month) {
      return await Expense.findAll({
        attributes: [
          [groupFunction, "label"],
          [sequelize.fn("SUM", sequelize.col("amount")), "totalAmount"],
        ],
        group: groupFunction,
        where: {
          [Op.and]: [
            sequelize.where(sequelize.fn("YEAR", sequelize.col("date")), year),
            sequelize.where(
              sequelize.fn("MONTH", sequelize.col("date")),
              month
            ),
          ],
        },
      });
    } else {
      throw new Error("Year or month missing");
    }
  } else if (groupBy === "year") {
    groupFunction = sequelize.literal("DATEPART(MONTH, date)");
    if (year) {
      return await Expense.findAll({
        attributes: [
          [groupFunction, "label"],
          [sequelize.fn("SUM", sequelize.col("amount")), "totalAmount"],
        ],
        group: groupFunction,
        where: {
          [Op.and]: [
            sequelize.where(sequelize.fn("YEAR", sequelize.col("date")), year),
          ],
        },
      });
    } else {
      throw new Error("Year missing");
    }
  } else {
    groupFunction = sequelize.literal("DATEPART(YEAR, date)");
    return await Expense.findAll({
      attributes: [
        [groupFunction, "label"],
        [sequelize.fn("SUM", sequelize.col("amount")), "totalAmount"],
      ],
      group: groupFunction,
    });
  }
};

const getBusFeeGraph = async (data) => {
  let groupFunction;
  const { groupBy, year, month, week } = data;
  if (groupBy === "week") {
    groupFunction = sequelize.literal("DATEPART(DAY, date)");
    if (year && month && week) {
      return await BusFee.findAll({
        attributes: [
          [groupFunction, "label"],
          [sequelize.fn("SUM", sequelize.col("amount")), "totalAmount"],
        ],
        group: groupFunction,
        where: {
          [Op.and]: [
            sequelize.where(sequelize.fn("YEAR", sequelize.col("date")), year),
            sequelize.where(
              sequelize.fn("MONTH", sequelize.col("date")),
              month
            ),
            sequelize.where(
              sequelize.literal(`DATEPART(WEEK, date)`),
              4 * Number(month) + Number(week)
            ),
          ],
        },
      });
    } else {
      throw new Error("Year missing");
    }
  } else if (groupBy === "month") {
    groupFunction = sequelize.literal("DATEPART(DAY, date)");
    if (year && month) {
      return await BusFee.findAll({
        attributes: [
          [groupFunction, "label"],
          [sequelize.fn("SUM", sequelize.col("amount")), "totalAmount"],
        ],
        group: groupFunction,
        where: {
          [Op.and]: [
            sequelize.where(sequelize.fn("YEAR", sequelize.col("date")), year),
            sequelize.where(
              sequelize.fn("MONTH", sequelize.col("date")),
              month
            ),
          ],
        },
      });
    } else {
      throw new Error("Year or month missing");
    }
  } else if (groupBy === "year") {
    groupFunction = sequelize.literal("DATEPART(MONTH, date)");
    if (year) {
      return await BusFee.findAll({
        attributes: [
          [groupFunction, "label"],
          [sequelize.fn("SUM", sequelize.col("amount")), "totalAmount"],
        ],
        group: groupFunction,
        where: {
          [Op.and]: [
            sequelize.where(sequelize.fn("YEAR", sequelize.col("date")), year),
          ],
        },
      });
    } else {
      throw new Error("Year missing");
    }
  } else {
    groupFunction = sequelize.literal("DATEPART(YEAR, date)");
    const response = BusFee.findAll({
      attributes: [
        [groupFunction, "label"],
        [sequelize.fn("SUM", sequelize.col("amount")), "totalAmount"],
      ],
      group: groupFunction,
    });
    return response
  }
};

const getFeedingGraph = async (data) => {
  let groupFunction;
  const { groupBy, year, month, week } = data;
  if (groupBy === "week") {
    groupFunction = sequelize.literal("DATEPART(DAY, date)");
    if (year && month && week) {
      return await FeedingFee.findAll({
        attributes: [
          [groupFunction, "label"],
          [sequelize.fn("SUM", sequelize.col("amount")), "totalAmount"],
        ],
        group: groupFunction,
        where: {
          [Op.and]: [
            sequelize.where(sequelize.fn("YEAR", sequelize.col("date")), year),
            sequelize.where(
              sequelize.fn("MONTH", sequelize.col("date")),
              month
            ),
            sequelize.where(
              sequelize.literal(`DATEPART(WEEK, date)`),
              4 * Number(month) + Number(week)
            ),
          ],
        },
      });
    } else {
      throw new Error("Year missing");
    }
  } else if (groupBy === "month") {
    groupFunction = sequelize.literal("DATEPART(DAY, date)");
    if (year && month) {
      return await FeedingFee.findAll({
        attributes: [
          [groupFunction, "label"],
          [sequelize.fn("SUM", sequelize.col("amount")), "totalAmount"],
        ],
        group: groupFunction,
        where: {
          [Op.and]: [
            sequelize.where(sequelize.fn("YEAR", sequelize.col("date")), year),
            sequelize.where(
              sequelize.fn("MONTH", sequelize.col("date")),
              month
            ),
          ],
        },
      });
    } else {
      throw new Error("Year or month missing");
    }
  } else if (groupBy === "year") {
    groupFunction = sequelize.literal("DATEPART(MONTH, date)");
    if (year) {
      return await FeedingFee.findAll({
        attributes: [
          [groupFunction, "label"],
          [sequelize.fn("SUM", sequelize.col("amount")), "totalAmount"],
        ],
        group: groupFunction,
        where: {
          [Op.and]: [
            sequelize.where(sequelize.fn("YEAR", sequelize.col("date")), year),
          ],
        },
      });
    } else {
      throw new Error("Year missing");
    }
  } else {
    groupFunction = sequelize.literal("DATEPART(YEAR, date)");
    const response = FeedingFee.findAll({
      attributes: [
        [groupFunction, "label"],
        [sequelize.fn("SUM", sequelize.col("amount")), "totalAmount"],
      ],
      group: groupFunction,
    });
    return response
  }
};

const getExtraClassesGraph = async (data) => {
  let groupFunction;
  const { groupBy, year, month, week } = data;
  if (groupBy === "week") {
    groupFunction = sequelize.literal("DATEPART(DAY, date)");
    if (year && month && week) {
      return await ExtraClasses.findAll({
        attributes: [
          [groupFunction, "label"],
          [sequelize.fn("SUM", sequelize.col("amount")), "totalAmount"],
        ],
        group: groupFunction,
        where: {
          [Op.and]: [
            sequelize.where(sequelize.fn("YEAR", sequelize.col("date")), year),
            sequelize.where(
              sequelize.fn("MONTH", sequelize.col("date")),
              month
            ),
            sequelize.where(
              sequelize.literal(`DATEPART(WEEK, date)`),
              4 * Number(month) + Number(week)
            ),
          ],
        },
      });
    } else {
      throw new Error("Year missing");
    }
  } else if (groupBy === "month") {
    groupFunction = sequelize.literal("DATEPART(DAY, date)");
    if (year && month) {
      return await ExtraClasses.findAll({
        attributes: [
          [groupFunction, "label"],
          [sequelize.fn("SUM", sequelize.col("amount")), "totalAmount"],
        ],
        group: groupFunction,
        where: {
          [Op.and]: [
            sequelize.where(sequelize.fn("YEAR", sequelize.col("date")), year),
            sequelize.where(
              sequelize.fn("MONTH", sequelize.col("date")),
              month
            ),
          ],
        },
      });
    } else {
      throw new Error("Year or month missing");
    }
  } else if (groupBy === "year") {
    groupFunction = sequelize.literal("DATEPART(MONTH, date)");
    if (year) {
      return await ExtraClasses.findAll({
        attributes: [
          [groupFunction, "label"],
          [sequelize.fn("SUM", sequelize.col("amount")), "totalAmount"],
        ],
        group: groupFunction,
        where: {
          [Op.and]: [
            sequelize.where(sequelize.fn("YEAR", sequelize.col("date")), year),
          ],
        },
      });
    } else {
      throw new Error("Year missing");
    }
  } else {
    groupFunction = sequelize.literal("DATEPART(YEAR, date)");
    const response = ExtraClasses.findAll({
      attributes: [
        [groupFunction, "label"],
        [sequelize.fn("SUM", sequelize.col("amount")), "totalAmount"],
      ],
      group: groupFunction,
    });
    return response
  }
};

const getFeesGraph = async (data) => {
  let groupFunction;
  const { groupBy, year, month, week } = data;
  if (groupBy === "week") {
    groupFunction = sequelize.literal("DATEPART(DAY, date_paid)");
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
              sequelize.literal(`DATEPART(WEEK, date_paid)`),
              4 * Number(month) + Number(week)
            ),
          ],
        },
      });
    } else {
      throw new Error("Year missing");
    }
  } else if (groupBy === "month") {
    groupFunction = sequelize.literal("DATEPART(DAY, date_paid)");
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
      throw new Error("Year or month missing");
    }
  } else if (groupBy === "year") {
    groupFunction = sequelize.literal("DATEPART(MONTH, date_paid)");
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
      throw new Error("Year missing");
    }
  } else {
    groupFunction = sequelize.literal("DATEPART(YEAR, date_paid)");
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

export { getExpenseGraph, getBusFeeGraph, getFeedingGraph, getExtraClassesGraph, getFeesGraph };
