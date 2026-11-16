import { Router } from "express";
import { requireAiFeature } from "../services/ai/gate.js";
import { actorOf } from "../services/ai/usage.js";
import {
  addQuestion,
  createPaper,
  deletePaper,
  deleteQuestion,
  getAnyPaper,
  getMyPaper,
  listAllPapers,
  listMyPapers,
  removeSection,
  reorderSection,
  setPaperStatus,
  updatePaper,
  updateQuestion,
} from "../services/papers.js";
// Importing paperAi registers the PAPERS accept handler.
import { acceptSection, discardDraft, generateSection, regenerateItem, saveDraft } from "../services/paperAi.js";
import { authenticateManagementUser, authorizeRoles } from "../utils/middlewares.js";

// AI-3: question papers.
//
// paperTeacherRouter: /teacher/papers*, used inside teacherRouter (its
// staffToken has already checked the portal STAFF token). Writing a paper by
// hand needs no AI, so only generate / regenerate carry requireAiFeature
// ("PAPERS"): switches, role and the monthly cap. Reviewing, editing,
// accepting and discarding drafts work with AI off, so waiting drafts are
// never stranded. A teacher only ever reaches their own papers (404 otherwise).
//
// paperOfficeRouter: /question-papers*, the head teacher's read-only view of
// every paper (Administrator).
const send = (fn) => async (req, res, next) => {
  try {
    res.json(await fn(req, res));
  } catch (error) {
    next(error);
  }
};
const me = (req) => Number(req.user?.id);
const actor = (req) => actorOf(req.user);

const teacher = Router();
const P = "/teacher/papers";

teacher.get(P, send((req) => listMyPapers(me(req), req.query)));
teacher.post(P, send((req) => createPaper(me(req), req.body || {})));
teacher.get(`${P}/:id`, send((req) => getMyPaper(me(req), req.params.id)));
teacher.patch(`${P}/:id`, send((req) => updatePaper(me(req), req.params.id, req.body || {})));
teacher.delete(`${P}/:id`, send((req) => deletePaper(me(req), req.params.id, { actor: actor(req) })));
// { status: "FINAL" } marks it final; { status: "DRAFT" } reopens it (owner only).
teacher.post(`${P}/:id/status`, send((req) => setPaperStatus(me(req), req.params.id, req.body?.status)));

// Sections
teacher.delete(`${P}/:id/sections/:n`, send((req) => removeSection(me(req), req.params.id, req.params.n, { actor: actor(req) })));
teacher.post(`${P}/:id/sections/:n/accept`, send((req) => acceptSection(req.user, req.params.id, req.params.n)));
teacher.put(`${P}/:id/sections/:n/order`, send((req) => reorderSection(me(req), req.params.id, req.params.n, req.body?.questionIds)));
teacher.post(`${P}/:id/sections/:n/questions`, send((req) => addQuestion(me(req), req.params.id, req.params.n, req.body || {})));
// AI: one section as a draft (at most 20 items), checked blind.
teacher.post(
  `${P}/:id/sections/:n/generate`,
  requireAiFeature("PAPERS"),
  send((req) => generateSection(req.user, req.params.id, req.params.n, { note: req.body?.note }))
);

// Questions by hand
teacher.patch(`${P}/:id/questions/:qid`, send((req) => updateQuestion(me(req), req.params.id, req.params.qid, req.body || {})));
teacher.delete(`${P}/:id/questions/:qid`, send((req) => deleteQuestion(me(req), req.params.id, req.params.qid)));

// AI drafts of a section
teacher.put(`${P}/:id/drafts/:sid`, send((req) => saveDraft(req.user, req.params.id, req.params.sid, req.body?.items)));
teacher.post(`${P}/:id/drafts/:sid/discard`, send((req) => discardDraft(req.user, req.params.id, req.params.sid)));
teacher.post(
  `${P}/:id/drafts/:sid/regenerate`,
  requireAiFeature("PAPERS"),
  send((req) => regenerateItem(req.user, req.params.id, req.params.sid, { key: req.body?.key, note: req.body?.note }))
);

// Office: the head teacher can view every paper (read-only).
const office = Router();
const ADMIN = [authenticateManagementUser, authorizeRoles("Administrator")];
office.get("/question-papers", ...ADMIN, send((req) => listAllPapers(req.query)));
office.get("/question-papers/:id", ...ADMIN, send((req) => getAnyPaper(req.params.id)));

export { teacher as paperTeacherRouter, office as paperOfficeRouter };
