import {
  bulkGenerate,
  createCreditNote,
  generateInvoice,
  getInvoice,
  invoicesForPrint,
  issueInvoice,
  listCreditNotes,
  listInvoices,
  portalInvoice,
  portalInvoices,
  voidCreditNote,
  voidInvoice,
} from "../services/invoices.js";

// B14: invoices and credit notes. Routes in routes/invoiceRoutes.js.
const handle = (fn) => async (req, res, next) => {
  try {
    res.json(await fn(req, res));
  } catch (error) {
    next(error);
  }
};
// Who did it comes from the token, never the body.
const who = (req) => ({ by: req.user?.username ?? null });

export const fetchInvoices = handle((req) => listInvoices(req.query));
export const fetchInvoicesForPrint = handle((req) => invoicesForPrint(req.query));
export const fetchInvoice = handle((req) => getInvoice(req.params.id));
export const makeInvoice = handle((req) => generateInvoice(req.body, who(req)));
export const makeInvoicesInBulk = handle((req) => bulkGenerate(req.body, who(req)));
export const issueOneInvoice = handle((req) => issueInvoice(req.params.id, req.body, who(req)));
export const voidOneInvoice = handle((req) => voidInvoice(req.params.id, req.body, who(req)));

export const fetchCreditNotes = handle((req) => listCreditNotes(req.query));
export const makeCreditNote = handle((req) => createCreditNote(req.body, who(req)));
export const voidOneCreditNote = handle((req) => voidCreditNote(req.params.id, req.body, who(req)));

// Portal: the signed-in pupil's own invoices (token id, never a query id).
export const fetchMyInvoices = handle((req) => portalInvoices(req.user.id));
export const fetchMyInvoice = handle((req) => portalInvoice(req.user.id, req.params.id));
