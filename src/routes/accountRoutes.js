import { Router } from "express";
import { addAccountCategory, addExpense, addIncome, deleteAccountCategory, deleteExpense, deleteIncome, fetchAccountCategory, fetchExpense, fetchIncome } from "../controllers/accountController.js";
import { addSalary } from "../controllers/generalController.js";

const router = Router();

router.get("/expense", fetchExpense);
router.post("/add-expense", addExpense);
router.delete("/delete-expense/:expense_id", deleteExpense);

router.get("/income", fetchIncome);
router.post("/add-income", addIncome);
router.delete("/delete-income/:income_id", deleteIncome);

router.get("/account-category", fetchAccountCategory);
router.post("/add-account-category", addAccountCategory);
router.delete("/delete-account-category/:account_category_id", deleteAccountCategory);

export { router as accountRouter };