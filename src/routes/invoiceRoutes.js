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
import { authenticateUser, authorizeRoles } from "../utils/middlewares.js";
import { ACCOUNTANT, ADMINISTRATOR } from "../utils/roles.js";

// B14: invoices and credit notes.
//   invoiceRouter: mounted in src/index.js behind authenticateManagementUser.
//     - Invoices (make, issue, void, print): Administrator and Accountant.
//     - Credit notes change what a pupil owes: Administrator only (default,
//       like payment reversal); the list is open to the Accountant too.
//     - Class Teachers: no access.
//   invoicePortalRouter: mounted at /portal/invoices before the management
//     routers. Pupil (STU) tokens only (parents use the pupil login); their own
//     issued invoices, by token id.
const ADMIN_ONLY = authorizeRoles(ADMINISTRATOR);
const FINANCE = authorizeRoles(ADMINISTRATOR, ACCOUNTANT);

const router = Router();

// Fixed paths before /invoices/:id.
router.get("/invoices", FINANCE, fetchInvoices);
router.get("/invoices/print", FINANCE, fetchInvoicesForPrint);
router.post("/invoices/generate", FINANCE, makeInvoice);
router.post("/invoices/bulk", FINANCE, makeInvoicesInBulk);
router.get("/invoices/:id", FINANCE, fetchInvoice);
router.post("/invoices/:id/issue", FINANCE, issueOneInvoice);
router.post("/invoices/:id/void", FINANCE, voidOneInvoice);

router.get("/credit-notes", FINANCE, fetchCreditNotes);
router.post("/credit-notes", ADMIN_ONLY, makeCreditNote);
router.post("/credit-notes/:id/void", ADMIN_ONLY, voidOneCreditNote);

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
