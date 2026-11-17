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
import { authorizeRoles } from "../utils/middlewares.js";
import { ACCOUNTANT, ADMINISTRATOR } from "../utils/roles.js";

// B12: discounts, per-term billing (with arrears carried forward) and fee
// statements. Mounted in src/index.js behind authenticateManagementUser.
//   - Discount TYPES (what discounts exist, their amounts): Administrator.
//   - Giving pupils discounts, billing a term, statements: Administrator and
//     Accountant (the bursar) (default; client question B12.3).
const ADMIN_ONLY = authorizeRoles(ADMINISTRATOR);
const FINANCE = authorizeRoles(ADMINISTRATOR, ACCOUNTANT);

const router = Router();

router.get("/discount-types", FINANCE, fetchDiscountTypes);
router.post("/discount-types", ADMIN_ONLY, addDiscountType);
router.patch("/discount-types/:id", ADMIN_ONLY, editDiscountType);
router.delete("/discount-types/:id", ADMIN_ONLY, removeDiscountType);

router.get("/student-discounts/sibling-suggestions", FINANCE, fetchSiblingSuggestions);
router.get("/student-discounts", FINANCE, fetchStudentDiscounts);
router.post("/student-discounts", FINANCE, giveStudentDiscount);
router.patch("/student-discounts/:id", FINANCE, endDiscount);
router.delete("/student-discounts/:id", FINANCE, deleteStudentDiscount);

router.get("/term-billing/:termId/preview", FINANCE, fetchTermBillingPreview);
router.post("/term-billing/:termId/bill", FINANCE, billTermClass);

router.get("/fee-statement/:studentId", FINANCE, fetchFeeStatement);

export { router as feeBillingRouter };
