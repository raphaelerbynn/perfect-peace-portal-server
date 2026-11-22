// AI-0: the draft-and-approve store (ported from SchoolPro's
// ai-suggestion.service.ts). Every AI result is written here first; the real
// record is untouched until a person accepts the draft.
//
//   PENDING --edit--> EDITED --edit--> EDITED
//   PENDING|EDITED --accept--> ACCEPTED   (runs the feature's accept handler)
//   PENDING|EDITED --reject--> REJECTED   (nothing written anywhere)
//   ACCEPTED / REJECTED are final. Accepting twice / rejecting twice returns
//   the row again (a double click is not an error).
//
// A feature registers how its drafts are applied, once, at import:
//   registerAcceptHandler("ANNOUNCEMENTS", async (suggestion, { transaction, actor }) => {
//     const post = await createPost({ ...suggestion.content }, { transaction });
//     return { entityId: String(post.postId) };     // optional: links the draft to the record
//   }, { validateContent: (content) => (content.body ? null : "The notice needs some text.") });
//
// The handler runs INSIDE the transaction that marks the row ACCEPTED (row
// locked FOR UPDATE), so a handler that throws leaves the draft as it was and
// two clicks can't apply it twice. Use the given transaction for its writes.
//
// { officeReviewable: false } keeps a feature's drafts out of the office
// /ai/suggestions endpoints: they belong to the person who asked for them
// (AI-3 paper drafts belong to the teacher) and are reviewed only through the
// feature's own routes, which call these functions with { includePrivate: true }
// and a scope. validateContent(content, { previous, entityId, field }) gets the
// row's current content on an edit (undefined on create), so a feature can pin
// fields that must never change.
import { Op } from "sequelize";
import sequelize from "../../config/database.js";
import { AiSuggestion } from "../../models/index.js";
import { AppError } from "../../utils/errorHandling.js";
import { paginatedResponse, parsePagination } from "../../utils/pagination.js";
import { AI_FEATURE_KEYS, AI_OPEN_SUGGESTION_STATUSES, AI_SUGGESTION_STATUSES } from "./constants.js";

const handlers = new Map(); // feature -> { accept, validateContent, officeReviewable }

export const registerAcceptHandler = (feature, accept, { validateContent, officeReviewable = true } = {}) => {
  if (!AI_FEATURE_KEYS.includes(feature)) throw new Error(`Unknown AI feature "${feature}"`);
  if (typeof accept !== "function") throw new Error(`The accept handler for ${feature} must be a function`);
  if (handlers.has(feature)) throw new Error(`An accept handler is already registered for ${feature}`);
  handlers.set(feature, { accept, validateContent, officeReviewable: officeReviewable !== false });
};
export const hasAcceptHandler = (feature) => handlers.has(feature);
/** Features whose drafts the office endpoints never list or touch. */
export const privateFeatures = () => [...handlers].filter(([, h]) => !h.officeReviewable).map(([f]) => f);
const isPrivate = (feature) => handlers.get(feature)?.officeReviewable === false;
/** Tests only. */
export const resetAcceptHandlers = () => handlers.clear();

const MAX_CONTENT_CHARS = 100_000;

const checkContent = (feature, content, context = {}) => {
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    throw new AppError("The draft content must be an object.", 400);
  }
  let size;
  try {
    size = JSON.stringify(content).length;
  } catch {
    throw new AppError("The draft content can't be saved.", 400);
  }
  if (size > MAX_CONTENT_CHARS) throw new AppError("The draft is too long to save.", 400);
  const problem = handlers.get(feature)?.validateContent?.(content, context);
  if (problem) throw new AppError(typeof problem === "string" ? problem : "The draft is not valid.", 400);
};

const str = (v, max) => (v === undefined || v === null || v === "" ? null : String(v).slice(0, max));

/**
 * Store a draft (always PENDING). Called by the feature right after runJson /
 * runText: model + promptVersion come from that result.
 */
export const createSuggestion = async (
  { feature, entityType, entityId, field, content, model, promptVersion, createdBy },
  { transaction } = {}
) => {
  if (!AI_FEATURE_KEYS.includes(feature)) throw new Error(`Unknown AI feature "${feature}"`);
  if (!entityType) throw new Error("A suggestion needs an entityType");
  checkContent(feature, content, { previous: undefined, entityId: str(entityId, 60), field: str(field, 60) });
  const now = new Date();
  const row = await AiSuggestion.create(
    {
      feature,
      entityType: str(entityType, 40),
      entityId: str(entityId, 60),
      field: str(field, 60),
      content,
      status: "PENDING",
      model: str(model, 60),
      promptVersion: str(promptVersion, 60),
      createdBy: str(createdBy, 110),
      createdAt: now,
      updatedAt: now,
    },
    { transaction }
  );
  return row.get ? row.get({ plain: true }) : row;
};

const ID_RE = /^\d{1,9}$/;
const parseId = (id) => {
  if (!ID_RE.test(String(id))) throw new AppError("Suggestion not found.", 404);
  return Number(id);
};

/**
 * List drafts, newest first. Filters: feature, status (one or comma list),
 * entityType, entityId, createdBy (e.g. a teacher's own: "STAFF:3"), page/limit.
 * Without ?limit the newest 200 are returned. Drafts of features registered
 * { officeReviewable: false } are never listed here.
 */
export const listSuggestions = async (query = {}) => {
  const where = {};
  const hidden = privateFeatures();
  if (query.feature) {
    if (!AI_FEATURE_KEYS.includes(query.feature)) throw new AppError("Unknown AI feature.", 400);
    // A private feature asked for by name: an empty list, like any feature with no drafts.
    where.feature = hidden.includes(query.feature) ? { [Op.in]: [] } : query.feature;
  } else if (hidden.length) {
    where.feature = { [Op.notIn]: hidden };
  }
  if (query.status) {
    const statuses = String(query.status).split(",").map((s) => s.trim().toUpperCase());
    if (statuses.some((s) => !AI_SUGGESTION_STATUSES.includes(s))) throw new AppError("Unknown suggestion status.", 400);
    where.status = statuses.length === 1 ? statuses[0] : statuses;
  }
  if (query.entityType) where.entityType = String(query.entityType);
  if (query.entityId) where.entityId = String(query.entityId);
  if (query.createdBy) where.createdBy = String(query.createdBy);

  const paging = parsePagination(query, { maxLimit: 100 });
  const options = { where, order: [["createdAt", "DESC"], ["suggestionId", "DESC"]], raw: true };
  if (paging) {
    const result = await AiSuggestion.findAndCountAll({ ...options, limit: paging.limit, offset: paging.offset });
    return paginatedResponse("suggestions", result, paging);
  }
  return { suggestions: await AiSuggestion.findAll({ ...options, limit: 200 }) };
};

/**
 * One draft. `scope` (optional where) narrows who may see it, e.g. { createdBy: "STAFF:3" }.
 * A draft of a feature that is not office-reviewable is 404 unless the
 * caller is that feature's own code ({ includePrivate: true }).
 */
export const getSuggestion = async (id, { scope, transaction, lock = false, includePrivate = false } = {}) => {
  const row = await AiSuggestion.findOne({
    where: { suggestionId: parseId(id), ...(scope || {}) },
    raw: true,
    ...(transaction ? { transaction } : {}),
    ...(lock && transaction?.LOCK ? { lock: transaction.LOCK.UPDATE } : {}),
  });
  if (!row || (!includePrivate && isPrivate(row.feature))) throw new AppError("Suggestion not found.", 404);
  return row;
};

const assertOpen = (row, verb) => {
  if (!AI_OPEN_SUGGESTION_STATUSES.includes(row.status)) {
    throw new AppError(`This draft is already ${row.status.toLowerCase()} and can't be ${verb}.`, 409);
  }
};

/** A person rewrote the draft. Stays a draft (EDITED); nothing is applied. */
export const editSuggestion = async (id, content, { actor, scope, includePrivate = false } = {}) =>
  sequelize.transaction(async (transaction) => {
    const row = await getSuggestion(id, { scope, transaction, lock: true, includePrivate });
    assertOpen(row, "edited");
    checkContent(row.feature, content, { previous: row.content, entityId: row.entityId, field: row.field });
    const now = new Date();
    await AiSuggestion.update(
      { content, status: "EDITED", reviewedBy: str(actor, 110), reviewedAt: now, updatedAt: now },
      { where: { suggestionId: row.suggestionId }, transaction }
    );
    return { ...row, content, status: "EDITED", reviewedBy: str(actor, 110), reviewedAt: now, updatedAt: now };
  });

/**
 * Apply the draft through the feature's handler, exactly once. `user` is the
 * caller (req.user, with its permissions), passed on so the handler can check
 * what that login may do (AI-8: news.manage to make a post).
 */
export const acceptSuggestion = async (id, { actor, user = null, scope, includePrivate = false } = {}) =>
  sequelize.transaction(async (transaction) => {
    const row = await getSuggestion(id, { scope, transaction, lock: true, includePrivate });
    if (row.status === "ACCEPTED") return row; // double click: same answer
    assertOpen(row, "accepted");
    const handler = handlers.get(row.feature);
    if (!handler) {
      throw new AppError(`Drafts for ${row.feature} can't be accepted yet (that feature isn't built). The draft was left as it is.`, 400);
    }
    const result = (await handler.accept(row, { transaction, actor, user })) || {};
    const now = new Date();
    const patch = { status: "ACCEPTED", reviewedBy: str(actor, 110), reviewedAt: now, updatedAt: now };
    if (result.entityId !== undefined && result.entityId !== null) patch.entityId = str(result.entityId, 60);
    await AiSuggestion.update(patch, { where: { suggestionId: row.suggestionId }, transaction });
    return { ...row, ...patch, ...(result.data !== undefined ? { applied: result.data } : {}) };
  });

/** Close the draft. Nothing is written anywhere else. */
export const rejectSuggestion = async (id, { actor, scope, includePrivate = false } = {}) =>
  sequelize.transaction(async (transaction) => {
    const row = await getSuggestion(id, { scope, transaction, lock: true, includePrivate });
    if (row.status === "REJECTED") return row;
    assertOpen(row, "rejected");
    const now = new Date();
    const patch = { status: "REJECTED", reviewedBy: str(actor, 110), reviewedAt: now, updatedAt: now };
    await AiSuggestion.update(patch, { where: { suggestionId: row.suggestionId }, transaction });
    return { ...row, ...patch };
  });
