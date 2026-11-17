import { Router } from "express";
import {
  addDiscountType,
  billTermClass,
  deleteStudentDiscount,
  editDiscountType,
  endDiscount,
  fetchDiscountTypes,
  fetchFeeStatement,
  fetchSiblingSuggestions,
  fetchStudentDiscounts,
  fetchTermBillingPreview,
  giveStudentDiscount,
  removeDiscountType,
} from "../controllers/feeBillingController.js";
import { requirePermission } from "../utils/middlewares.js";

// B12: discounts, per-term billing (with arrears carried forward) and fee
// statements. Mounted in src/index.js behind authenticateManagementUser.
//   - Discount TYPES (what discounts exist, their amounts): billing.discount_types
//     (Administrator); the list also for whoever gives discounts.
//   - Giving pupils discounts, billing a term, statements: Administrator and
//     Accountant (the bursar) (default; client question B12.3).
const TYPES = requirePermission("billing.discount_types");
const TYPES_READ = requirePermission("billing.give_discounts", "billing.discount_types");
const DISCOUNTS = requirePermission("billing.give_discounts");
const BILL = requirePermission("billing.bill_term");
const STATEMENT = requirePermission("fees.view");

const router = Router();

router.get("/discount-types", TYPES_READ, fetchDiscountTypes);
router.post("/discount-types", TYPES, addDiscountType);
router.patch("/discount-types/:id", TYPES, editDiscountType);
router.delete("/discount-types/:id", TYPES, removeDiscountType);

router.get("/student-discounts/sibling-suggestions", DISCOUNTS, fetchSiblingSuggestions);
router.get("/student-discounts", DISCOUNTS, fetchStudentDiscounts);
router.post("/student-discounts", DISCOUNTS, giveStudentDiscount);
router.patch("/student-discounts/:id", DISCOUNTS, endDiscount);
router.delete("/student-discounts/:id", DISCOUNTS, deleteStudentDiscount);

router.get("/term-billing/:termId/preview", BILL, fetchTermBillingPreview);
router.post("/term-billing/:termId/bill", BILL, billTermClass);

router.get("/fee-statement/:studentId", STATEMENT, fetchFeeStatement);

export { router as feeBillingRouter };
