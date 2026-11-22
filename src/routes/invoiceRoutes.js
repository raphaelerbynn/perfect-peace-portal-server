import { Router } from "express";
import {
  fetchCreditNotes,
  fetchInvoice,
  fetchInvoices,
  fetchInvoicesForPrint,
  fetchMyInvoice,
  fetchMyInvoices,
  issueOneInvoice,
  makeCreditNote,
  makeInvoice,
  makeInvoicesInBulk,
  voidOneCreditNote,
  voidOneInvoice,
} from "../controllers/invoiceController.js";
import { authenticateUser, requirePermission } from "../utils/middlewares.js";

// B14: invoices and credit notes.
//   invoiceRouter: mounted in src/index.js behind authenticateManagementUser.
//     - Invoices: invoices.view (see, print) and invoices.manage (make, issue,
//       void): Administrator and Accountant.
//     - Credit notes change what a pupil owes: invoices.credit_notes
//       (Administrator, like payment reversal); the list is invoices.view.
//     - Class Teachers: no access.
//   invoicePortalRouter: mounted at /portal/invoices before the management
//     routers. Pupil (STU) tokens only (parents use the pupil login); their own
//     issued invoices, by token id.
const VIEW = requirePermission("invoices.view");
const MANAGE = requirePermission("invoices.manage");
const CREDIT = requirePermission("invoices.credit_notes");

const router = Router();

// Fixed paths before /invoices/:id.
router.get("/invoices", VIEW, fetchInvoices);
router.get("/invoices/print", VIEW, fetchInvoicesForPrint);
router.post("/invoices/generate", MANAGE, makeInvoice);
router.post("/invoices/bulk", MANAGE, makeInvoicesInBulk);
router.get("/invoices/:id", VIEW, fetchInvoice);
router.post("/invoices/:id/issue", MANAGE, issueOneInvoice);
router.post("/invoices/:id/void", MANAGE, voidOneInvoice);

router.get("/credit-notes", VIEW, fetchCreditNotes);
router.post("/credit-notes", CREDIT, makeCreditNote);
router.post("/credit-notes/:id/void", CREDIT, voidOneCreditNote);

const portal = Router();
const pupilOnly = (req, res, next) =>
  authenticateUser(req, res, (err) => {
    if (err) return next(err);
    if (req.user?.category || req.user?.userRole !== "STU") {
      res.status(403);
      return next(new Error("You do not have permission to perform this action"));
    }
    return next();
  });
portal.use(pupilOnly);
portal.get("/", fetchMyInvoices);
portal.get("/:id", fetchMyInvoice);

export { router as invoiceRouter, portal as invoicePortalRouter };
