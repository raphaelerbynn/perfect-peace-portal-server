import { createAccountCategory, createExpense, createIncome, getAccountCategory, getExpense, getIncome, removeAccountCategory, removeExpense, removeIncome } from "../services/account.js";

//category
export const fetchAccountCategory = async (req, res, next) => {
  const type = req.query.type
  try {
    const _accountCatgory = await getAccountCategory(type);
    res.status(200).json(_accountCatgory);
  } catch (error) {
    next(error);
  }
};

export const addAccountCategory = async (req, res, next) => {
  const accountCategoryData = req.body;
  try {
    const _accountCatgory = await createAccountCategory(accountCategoryData);
    res.status(201).json(_accountCatgory);
  } catch (error) {
    next(error);
  }
};

export const deleteAccountCategory = async (req, res, next) => {
  const accountCategoryId = req.params.account_category_id;
  try {
    const _accountCatgory = await removeAccountCategory(accountCategoryId);
    res.status(200).json(_accountCatgory);
  } catch (error) {
    next(error);
  }
};

// expense
export const deleteExpense = async (req, res, next) => {
    const id = req.params.expense_id;
    try {
      const data = await removeExpense(id);
      res.json(data);
    } catch (error) {
      console.log(error)
      next(error)
    }
  }

 export const fetchExpense = async (req, res, next) => {
    const values = req.query;
    try {
      const data = await getExpense(values);
      res.json(data);
    } catch (error) {
      console.log(error);
      next(error);
    }
  }

 export const addExpense = async (req, res, next) => {
    const values = req.body;
    // console.log(values);
    try {
      const data = await createExpense(values);
      res.json(data);
    } catch (error) {
      console.log(error);
      next(error);
    }
  };


// income
export const deleteIncome = async (req, res, next) => {
    const id = req.params.income_id;
    try {
      const data = await removeIncome(id);
      res.json(data);
    } catch (error) {
      console.log(error)
      next(error)
    }
  }

 export const fetchIncome = async (req, res, next) => {
    const values = req.query;
    try {
      const data = await getIncome(values);
      res.json(data);
    } catch (error) {
      console.log(error);
      next(error);
    }
  }

 export const addIncome = async (req, res, next) => {
    const values = req.body;
    // console.log(values);
    try {
      const data = await createIncome(values);
      res.json(data);
    } catch (error) {
      console.log(error);
      next(error);
    }
  };


