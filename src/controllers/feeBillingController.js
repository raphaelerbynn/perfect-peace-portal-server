import {
  addStudentDiscount,
  createDiscountType,
  deleteDiscountType,
  endStudentDiscount,
  listDiscountTypes,
  listStudentDiscounts,
  removeStudentDiscount,
  siblingSuggestions,
  updateDiscountType,
} from "../services/discounts.js";
import { getStatement } from "../services/feeStatement.js";
import { billClassForTerm, previewTermBilling } from "../services/termBilling.js";

// B12: discounts, term billing, statements. Routes in routes/feeBillingRoutes.js.
const handle = (fn) => async (req, res, next) => {
  try {
    res.json(await fn(req, res));
  } catch (error) {
    next(error);
  }
};
const who = (req) => req.user?.username ?? null;

export const fetchDiscountTypes = handle((req) => listDiscountTypes(req.query));
export const addDiscountType = handle((req) => createDiscountType(req.body, { createdBy: who(req) }));
export const editDiscountType = handle((req) => updateDiscountType(req.params.id, req.body));
export const removeDiscountType = handle((req) => deleteDiscountType(req.params.id));

export const fetchStudentDiscounts = handle((req) => listStudentDiscounts(req.query.studentId));
export const giveStudentDiscount = handle((req) => addStudentDiscount(req.body, { createdBy: who(req) }));
export const endDiscount = handle((req) => endStudentDiscount(req.params.id, req.body));
export const deleteStudentDiscount = handle((req) => removeStudentDiscount(req.params.id));
export const fetchSiblingSuggestions = handle(() => siblingSuggestions());

export const fetchTermBillingPreview = handle((req) => previewTermBilling(req.params.termId, req.query));
export const billTermClass = handle((req) => billClassForTerm({ ...req.body, termId: req.params.termId }, { billedBy: who(req) }));

export const fetchFeeStatement = handle((req) => getStatement(req.params.studentId));
