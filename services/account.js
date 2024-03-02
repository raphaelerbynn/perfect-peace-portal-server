import { AccountCategory, BusFee, Expense, ExtraClasses, FeedingFee, Income } from "../models/index.js";
import { Op, literal } from "sequelize";

const createFeeding = async (data) => {
  const response = await FeedingFee.create({
    teacher: data?.teacher,
    class: data?.class,
    amount: data?.amount,
    date: data?.date,
  });

  return response;
};

// const createExpense = async (data) => {
//   const response = await Expense.create({
//     expense: data?.expense,
//     amount: data?.amount,
//     date: data?.date,
//   });

//   return response;
// };

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
  if (data.all === "true") {
    return await FeedingFee.findAll();
  } else if (data.startDate === data.endDate) {
    const startDate = new Date(data.startDate).toISOString();
    return await FeedingFee.findAll({
      where: {
        date: {
          [Op.eq]: literal(`CONVERT(DATE, '${startDate}', 126)`),
        },
      },
    });
  } else {
    const startDate = new Date(data.startDate).toISOString();
    const endDate = new Date(data.endDate).toISOString();
    return await FeedingFee.findAll({
      where: {
        date: {
          [Op.gte]: literal(`CONVERT(DATE, '${startDate}', 126)`),
          [Op.lte]: literal(`CONVERT(DATE, '${endDate}', 126)`),
        },
      },
    });
  }
};

const getExpense = async (data) => {
  if (!data.startDate || data.all === "true") {
    return await getAllExpense();
  } else if (data.startDate === data.endDate) {
    const startDate = new Date(data.startDate).toISOString();
    return await Expense.findAll({
      where: {
        date: {
          [Op.eq]: literal(`CONVERT(DATE, '${startDate}', 126)`),
        },
      },
    });
  } else {
    const startDate = new Date(data.startDate).toISOString();
    const endDate = new Date(data.endDate).toISOString();
    return await Expense.findAll({
      where: {
        date: {
          [Op.gte]: literal(`CONVERT(DATE, '${startDate}', 126)`),
          [Op.lte]: literal(`CONVERT(DATE, '${endDate}', 126)`),
        },
      },
    });
  }
};

const getIncome = async (data) => {
  if (!data.startDate || data.all === "true") {
    return await getAllIncome();
  } else if (data.startDate && data.startDate === data.endDate) {
    console.log("data start:::", data.startDate)
    const startDate = new Date(data?.startDate)?.toISOString();
    return await Income.findAll({
      where: {
        date: {
          [Op.eq]: literal(`CONVERT(DATE, '${startDate}', 126)`),
        },
      },
    });
  } else {
    const startDate = new Date(data?.startDate).toISOString();
    const endDate = new Date(data?.endDate).toISOString();
    return await Income.findAll({
      where: {
        date: {
          [Op.gte]: literal(`CONVERT(DATE, '${startDate}', 126)`),
          [Op.lte]: literal(`CONVERT(DATE, '${endDate}', 126)`),
        },
      },
    });
  }
};

const getExtraClasses = async (data) => {
  if (data.all === "true") {
    return await ExtraClasses.findAll();
  } else if (data.startDate === data.endDate) {
    const startDate = new Date(data.startDate).toISOString();
    return await ExtraClasses.findAll({
      where: {
        date: {
          [Op.eq]: literal(`CONVERT(DATE, '${startDate}', 126)`),
        },
      },
    });
  } else {
    const startDate = new Date(data.startDate).toISOString();
    const endDate = new Date(data.endDate).toISOString();
    return await ExtraClasses.findAll({
      where: {
        date: {
          [Op.gte]: literal(`CONVERT(DATE, '${startDate}', 126)`),
          [Op.lte]: literal(`CONVERT(DATE, '${endDate}', 126)`),
        },
      },
    });
  }
};

const getBusFee = async (data) => {
  if (data.all === "true") {
    return await BusFee.findAll();
  } else if (data.startDate === data.endDate) {
    const startDate = new Date(data.startDate).toISOString();
    return await BusFee.findAll({
      where: {
        date: {
          [Op.eq]: literal(`CONVERT(DATE, '${startDate}', 126)`),
        },
      },
    });
  } else {
    const startDate = new Date(data.startDate).toISOString();
    const endDate = new Date(data.endDate).toISOString();
    return await BusFee.findAll({
      where: {
        date: {
          [Op.gte]: literal(`CONVERT(DATE, '${startDate}', 126)`),
          [Op.lte]: literal(`CONVERT(DATE, '${endDate}', 126)`),
        },
      },
    });
  }
};

const removeFeeding = async (id) => {
  const response = await FeedingFee.destroy({
    where: {
      feeding: id,
    },
  });
  return response;
};

// const removeExpense = async (id) => {
//   const response = await Expense.destroy({
//     where: {
//       expenseId: id,
//     },
//   });
//   return response;
// };

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

//account category
export const getAccountCategory = async () => {
  return await AccountCategory.findAll({ raw: true });
};

export const createAccountCategory = async (data) => {
  return await AccountCategory.create(data);
};

export const removeAccountCategory = async (accountCategoryId) => {
  return await AccountCategory.destroy({
    where: {
      accountCategoryId: accountCategoryId,
    },
  });
};

//expense
export const getAllExpense = async () => {
  return await Expense.findAll({
    include: [
      {
        model: AccountCategory,
        as: "accountCategory",
        attributes: ["name"],
      },
    ],
    order: [['expenseId', 'DESC']],
  });
};

export const createExpense = async (data) => {
  return await Expense.create(data);
};

export const editExpense = async (
  expenseId,
  data
) => {
  return await Expense.update(data, {
    where: {
      expenseId: expenseId,
    },
  });
};

export const removeExpense = async (expenseId) => {
  return await Expense.destroy({
    where: {
      expenseId: expenseId,
    },
  });
};

//income
export const getAllIncome = async () => {
  const result = await Income.findAll({
    include: [
      {
        model: AccountCategory,
        as: "accountCategory",
        attributes: ["name"],
      },
    ],
    order: [['incomeId', 'DESC']],
  });
  return result
};

export const createIncome = async (data) => {
  return await Income.create(data);
};

export const editIncome = async (
  incomeId,
  data
) => {
  return await Income.update(data, {
    where: {
      incomeId: incomeId,
    },
  });
};

export const removeIncome = async (incomeId) => {
  return await Income.destroy({
    where: {
      incomeId: incomeId,
    },
  });
};



export {
  createFeeding,
  // createExpense,
  createExtraClasses,
  createBusFee,
  getFeeding,
  getExpense,
  getIncome,
  getExtraClasses,
  getBusFee,
  removeFeeding,
  // removeExpense,
  removeExtraClasses,
  removeBusFee,
};
