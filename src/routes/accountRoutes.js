import { Router } from "express";
import { requirePermission } from "../utils/middlewares.js";
import { addAccountCategory, addExpense, addIncome, deleteAccountCategory, deleteExpense, deleteIncome, fetchAccountCategory, fetchExpense, fetchIncome } from "../controllers/accountController.js";

// Mounted in src/index.js behind authenticateManagementUser. B10: reading is
// accounting.view, recording and deleting accounting.manage (Administrator,
// Accountant; before B10 one Administrator + Accountant gate on the mount).
const VIEW = requirePermission("accounting.view");
const MANAGE = requirePermission("accounting.manage");

const router = Router();

router.get("/expense", VIEW, fetchExpense);
router.post("/add-expense", MANAGE, addExpense);
router.delete("/delete-expense/:expense_id", MANAGE, deleteExpense);

router.get("/income", VIEW, fetchIncome);
router.post("/add-income", MANAGE, addIncome);
router.delete("/delete-income/:income_id", MANAGE, deleteIncome);

router.get("/account-category", VIEW, fetchAccountCategory);
router.post("/add-account-category", MANAGE, addAccountCategory);
router.delete("/delete-account-category/:account_category_id", MANAGE, deleteAccountCategory);

export { router as accountRouter };