import {
  acceptPromotion,
  getHistory,
  getLadder,
  getPreview,
  getRules,
  getStatus,
  saveLadder,
  saveRules,
} from "../services/promotion.js";

// B5: promotion (preview -> accept), pass marks, class order, history.
const handle = (fn) => async (req, res, next) => {
  try {
    res.json(await fn(req, res));
  } catch (error) {
    next(error);
  }
};
const who = (req) => req.user?.username ?? null;

const fetchPromotionRules = handle(() => getRules());
const updatePromotionRules = handle((req) => saveRules(req.body, { updatedBy: who(req) }));
const fetchClassOrder = handle(() => getLadder());
const updateClassOrder = handle((req) => saveLadder(req.body?.classes));
const fetchPromotionPreview = handle((req) => getPreview(req.query));
const acceptClassPromotion = handle((req) => acceptPromotion(req.body, { decidedBy: who(req) }));
const fetchPromotionStatus = handle((req) => getStatus(req.query));
const fetchPromotionHistory = handle((req) => getHistory(req.params.studentId, req.user));

export {
  fetchPromotionRules,
  updatePromotionRules,
  fetchClassOrder,
  updateClassOrder,
  fetchPromotionPreview,
  acceptClassPromotion,
  fetchPromotionStatus,
  fetchPromotionHistory,
};
