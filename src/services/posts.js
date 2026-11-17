// B15: school news feed, events calendar and polls.
//
// Posts live in the old "Event" table (migration 037): name = title,
// description = body, date = event (start) date. Types NEWS | EVENT | POLL,
// status DRAFT | PUBLISHED | ARCHIVED.
//
// Who sees what (enforced on EVERY read, including likes, comments, votes and
// the image of a post: a post the caller can't see is a 404):
//   - audience ALL      everyone;
//   - audience CLASSES  pupils of those classes, and all staff;
//   - audience STAFF    staff only (portal teachers and office logins);
//   - pupils and teachers see PUBLISHED posts only; an Administrator sees every
//     status; a Class Teacher also sees their own drafts/archived posts.
// Who posts (default): an Administrator, to any audience; a Class Teacher, to
// their own class only, and changes only their own posts. Pins and comment
// moderation: Administrator. Anyone who can see a published post may like it,
// comment (unless comments are off for it) and vote once on a poll.
//
// The viewer ("actor") is built by the router from the token:
//   { type: "OFFICE", category, username, teacherId }
//   { type: "STAFF", id, name }
//   { type: "STUDENT", id, classId, name }
import { Op, UniqueConstraintError, fn, col, literal } from "sequelize";
import { P } from "../utils/permissions.js";
import sequelize from "../config/database.js";
import { Class, Event, PollOption, PollVote, PostComment, PostLike, Student, Teacher } from "../models/index.js";
import { AppError } from "../utils/errorHandling.js";
import { saveUpload, storage } from "./storage.js";
import { notifyPostPublished } from "./notify.js";

export const POST_TYPES = ["NEWS", "EVENT", "POLL"];
export const STATUSES = ["DRAFT", "PUBLISHED", "ARCHIVED"];
export const AUDIENCES = ["ALL", "CLASSES", "STAFF"];
export const LIMITS = { title: 150, body: 10000, time: 40, location: 200, option: 200, comment: 1000, minOptions: 2, maxOptions: 10, maxClasses: 60 };
const FEED_MAX = 50;
const COMMENTS_MAX = 100;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;

const notFound = () => new AppError("Post not found", 404);

// ------------------------------------------------------------------ viewer
// B10: by permission (the office viewer carries its role's permissions).
const holds = (v, key) => v?.type === "OFFICE" && v.permissions instanceof Set && v.permissions.has(key);
// news.manage: runs the feed school-wide (any post, pin, hide comments, every
// draft). The Administrator.
export const isNewsManager = (v) => holds(v, P.NEWS_MANAGE);
// news.post without news.manage: writes posts and manages only their own (own
// drafts too). The Class Teacher.
export const isPoster = (v) => holds(v, P.NEWS_POST) && !isNewsManager(v);
// ...and only to the class linked to the login, unless academics.all_classes.
export const postsToOwnClassOnly = (v) => isPoster(v) && !holds(v, P.ALL_CLASSES);
const isStaffViewer = (v) => v?.type === "OFFICE" || v?.type === "STAFF";

export const actorOf = (v) => ({
  actorType: v.type,
  actorId: String(v.type === "OFFICE" ? v.username : v.id),
});

// Build the viewer from a verified token. Pupils: their class comes from the
// database (it changes with promotion), never from the request.
export const viewerFromUser = async (user) => {
  if (user?.category) {
    if (!user.username) throw new AppError("You do not have permission to perform this action", 403);
    // B10: an office login reads the feed with news.view (archived: none).
    if (!(user.permissions instanceof Set) || !user.permissions.has(P.NEWS_VIEW)) {
      throw new AppError("You do not have permission to perform this action", 403);
    }
    return {
      type: "OFFICE",
      category: user.category,
      username: String(user.username),
      teacherId: user.teacherId ?? null,
      // Loaded by the authenticator from the login's role (never the token).
      permissions: user.permissions instanceof Set ? user.permissions : new Set(),
    };
  }
  if (user?.userRole === "STU") {
    const s = await Student.findByPk(user.id, { attributes: ["studentId", "classId", "fName", "lName", "isDeleted"], raw: true });
    if (!s || s.isDeleted) throw new AppError("You do not have permission to perform this action", 403);
    return { type: "STUDENT", id: s.studentId, classId: s.classId ?? null, name: [s.fName, s.lName].filter(Boolean).join(" ") };
  }
  if (user?.userRole === "STAFF") {
    const t = await Teacher.findByPk(user.id, { attributes: ["teacherId", "fName", "lName", "isDeleted"], raw: true });
    if (!t || t.isDeleted) throw new AppError("You do not have permission to perform this action", 403);
    return { type: "STAFF", id: t.teacherId, name: [t.fName, t.lName].filter(Boolean).join(" ") };
  }
  throw new AppError("You do not have permission to perform this action", 403);
};

// ------------------------------------------------------------------ visibility
const classIdsOf = (post) => (Array.isArray(post?.audienceClassIds) ? post.audienceClassIds.map(Number) : []);

export const audienceAllows = (post, v) => {
  const audience = post?.audience || "ALL";
  if (audience === "ALL") return true;
  if (isStaffViewer(v)) return true;
  if (audience === "CLASSES" && v?.type === "STUDENT") {
    return v.classId != null && classIdsOf(post).includes(Number(v.classId));
  }
  return false;
};

export const statusAllows = (post, v) => {
  const status = post?.status || "PUBLISHED";
  if (status === "PUBLISHED") return true;
  if (isNewsManager(v)) return true;
  if (isPoster(v)) return post.createdBy != null && post.createdBy === v.username;
  return false;
};

export const canSee = (post, v) => !!post && audienceAllows(post, v) && statusAllows(post, v);

// The same rules as a Sequelize where clause (feed and calendar).
// publishedOnly: the calendar and the old /news list show published posts only.
export const visibilityWhere = (v, { publishedOnly = false } = {}) => {
  const and = [];
  if (v?.type === "STUDENT") {
    const or = [{ audience: "ALL" }];
    if (v.classId != null) or.push({ audience: "CLASSES", audienceClassIds: { [Op.contains]: [Number(v.classId)] } });
    and.push({ [Op.or]: or });
  } else if (!isStaffViewer(v)) {
    and.push({ audience: "ALL" });
  }
  if (publishedOnly) and.push({ status: "PUBLISHED" });
  else if (isPoster(v)) and.push({ [Op.or]: [{ status: "PUBLISHED" }, { createdBy: v.username }] });
  else if (!isNewsManager(v)) and.push({ status: "PUBLISHED" });
  return and;
};

export const canManage = (post, v) => isNewsManager(v) || (isPoster(v) && !!post?.createdBy && post.createdBy === v.username);

const loadVisible = async (postId, v, opts = {}) => {
  const id = Number(postId);
  if (!Number.isInteger(id) || id <= 0) throw notFound();
  const post = await Event.findByPk(id, opts);
  if (!post || !canSee(post, v)) throw notFound();
  return post;
};

// Likes, comments and votes: only on a published post.
const loadInteractive = async (postId, v, opts) => {
  const post = await loadVisible(postId, v, opts);
  if (post.status !== "PUBLISHED") throw new AppError("This post is not published.", 400);
  return post;
};

const loadManaged = async (postId, v, opts) => {
  const post = await loadVisible(postId, v, opts);
  if (!canManage(post, v)) throw new AppError("You can only change your own posts.", 403);
  return post;
};

// ------------------------------------------------------------------ validation
const text = (value) => (value === undefined || value === null ? "" : String(value).trim());
const validDate = (s) => {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const bool = (value, fallback) => (value === undefined || value === null ? fallback : value === true || value === "true");

const ownClassId = async (v) => {
  if (!v.teacherId) return null;
  const klass = await Class.findOne({ where: { teacherId: v.teacherId, isDeleted: false }, attributes: ["classId"], raw: true });
  return klass?.classId ?? null;
};

const cleanClassIds = async (ids) => {
  if (!Array.isArray(ids) || ids.length === 0) throw new AppError("Choose at least one class.", 400);
  const out = [...new Set(ids.map(Number))];
  if (out.some((x) => !Number.isInteger(x) || x <= 0) || out.length > LIMITS.maxClasses) {
    throw new AppError("Choose valid classes.", 400);
  }
  const found = await Class.count({ where: { classId: { [Op.in]: out }, isDeleted: false } });
  if (found !== out.length) throw new AppError("A chosen class does not exist.", 400);
  return out.sort((a, b) => a - b);
};

const cleanOptions = (options) => {
  if (!Array.isArray(options)) throw new AppError(`A poll needs ${LIMITS.minOptions} to ${LIMITS.maxOptions} choices.`, 400);
  const labels = options.map((o) => text(typeof o === "object" && o !== null ? o.label : o)).filter(Boolean);
  if (labels.length < LIMITS.minOptions || labels.length > LIMITS.maxOptions) {
    throw new AppError(`A poll needs ${LIMITS.minOptions} to ${LIMITS.maxOptions} choices.`, 400);
  }
  if (labels.some((l) => l.length > LIMITS.option)) throw new AppError(`Each choice can be at most ${LIMITS.option} characters.`, 400);
  if (new Set(labels.map((l) => l.toLowerCase())).size !== labels.length) throw new AppError("Two choices are the same.", 400);
  return labels;
};

// Validate a create (current = null) or an edit (current = the post). Returns
// the columns to write plus poll option labels (or null = unchanged).
export const validatePost = async (body = {}, v, current = null) => {
  const has = (k) => current === null || body[k] !== undefined;
  const postType = current ? current.postType : text(body.postType || "NEWS").toUpperCase();
  if (!POST_TYPES.includes(postType)) throw new AppError("Choose News, Event or Poll.", 400);
  if (current && body.postType !== undefined && text(body.postType).toUpperCase() !== current.postType) {
    throw new AppError("A post's type can't be changed.", 400);
  }

  const out = {};
  if (has("title")) {
    const title = text(body.title);
    if (!title) throw new AppError(postType === "POLL" ? "Write the poll question." : "Give the post a title.", 400);
    if (title.length > LIMITS.title) throw new AppError(`The title can be at most ${LIMITS.title} characters.`, 400);
    out.name = title;
  }
  if (has("body")) {
    const b = text(body.body);
    if (!b && postType !== "POLL") throw new AppError("Write the post.", 400);
    if (b.length > LIMITS.body) throw new AppError(`The post can be at most ${LIMITS.body} characters.`, 400);
    out.description = b || null;
  }

  // Dates: required for an EVENT, optional otherwise (old news rows have one).
  const date = has("eventDate") ? text(body.eventDate) : current?.date || "";
  const end = has("eventEndDate") ? text(body.eventEndDate) : current?.eventEndDate || "";
  if (date && !validDate(date)) throw new AppError("Choose a valid date.", 400);
  if (end && !validDate(end)) throw new AppError("Choose a valid end date.", 400);
  if (postType === "EVENT" && !date) throw new AppError("An event needs a date.", 400);
  if (end && !date) throw new AppError("Choose the start date too.", 400);
  if (end && end < date) throw new AppError("The end date is before the start date.", 400);
  if (has("eventDate")) out.date = date || null;
  if (has("eventEndDate")) out.eventEndDate = end || null;
  if (has("time")) {
    const t = text(body.time);
    if (t.length > LIMITS.time) throw new AppError(`The time can be at most ${LIMITS.time} characters.`, 400);
    out.time = t || null;
  }
  if (has("location")) {
    const l = text(body.location);
    if (l.length > LIMITS.location) throw new AppError(`The place can be at most ${LIMITS.location} characters.`, 400);
    out.location = l || null;
  }

  if (has("commentsEnabled")) out.commentsEnabled = bool(body.commentsEnabled, true);

  // Audience. A poster without "every class" (a Class Teacher) always posts to
  // their own class.
  if (postsToOwnClassOnly(v)) {
    const own = await ownClassId(v);
    if (!own) throw new AppError("You have no class to post to. Ask the administrator.", 403);
    if (current === null || body.audience !== undefined || body.audienceClassIds !== undefined) {
      const asked = body.audience === undefined ? "CLASSES" : text(body.audience).toUpperCase();
      const ids = body.audienceClassIds === undefined ? [own] : (Array.isArray(body.audienceClassIds) ? body.audienceClassIds.map(Number) : [NaN]);
      if (asked !== "CLASSES" || ids.length !== 1 || ids[0] !== Number(own)) {
        throw new AppError("Class Teachers can post to their own class only.", 403);
      }
      out.audience = "CLASSES";
      out.audienceClassIds = [Number(own)];
    }
  } else if (has("audience") || has("audienceClassIds")) {
    const audience = body.audience === undefined ? current?.audience || "ALL" : text(body.audience).toUpperCase();
    if (!AUDIENCES.includes(audience)) throw new AppError("Choose who can see the post.", 400);
    out.audience = audience;
    out.audienceClassIds =
      audience === "CLASSES"
        ? await cleanClassIds(body.audienceClassIds === undefined ? current?.audienceClassIds : body.audienceClassIds)
        : null;
  }

  let options = null;
  if (postType === "POLL") {
    if (current === null || body.options !== undefined) options = cleanOptions(body.options);
    if (has("pollClosesAt")) {
      const c = text(body.pollClosesAt);
      const d = c ? new Date(c) : null;
      if (d && Number.isNaN(d.getTime())) throw new AppError("Choose a valid closing time.", 400);
      out.pollClosesAt = d;
    }
  }

  return { postType, values: out, options };
};

// ------------------------------------------------------------------ shaping
const isoDate = (d) => (d ? new Date(d).toISOString() : null);
const pollClosed = (post, now = new Date()) => !!post.pollClosesAt && new Date(post.pollClosesAt) <= now;

// What the browser gets. Internal fields (image key, who wrote it, class ids)
// go to office logins only; pupils and teachers see "School".
export const serializePost = (post, v, extra = {}) => {
  const p = typeof post?.toJSON === "function" ? post.toJSON() : post;
  const office = v?.type === "OFFICE";
  const out = {
    postId: p.eventId,
    postType: p.postType || "NEWS",
    title: p.name,
    body: p.description ?? null,
    status: p.status || "PUBLISHED",
    isPinned: !!p.isPinned,
    eventDate: p.date ?? null,
    eventEndDate: p.eventEndDate ?? null,
    time: p.time ?? null,
    location: p.location ?? null,
    audience: p.audience || "ALL",
    commentsEnabled: p.commentsEnabled !== false,
    hasImage: !!p.imageKey,
    publishedAt: isoDate(p.publishedAt),
    pollClosesAt: isoDate(p.pollClosesAt),
    pollClosed: (p.postType === "POLL" && pollClosed(p)) || false,
    likeCount: 0,
    likedByMe: false,
    commentCount: 0,
    ...extra,
  };
  if (office) {
    out.audienceClassIds = classIdsOf(p);
    out.createdBy = p.createdBy ?? null;
    out.canManage = canManage(p, v);
  }
  return out;
};

const countBy = (rows, key) => Object.fromEntries(rows.map((r) => [r[key], Number(r.n)]));

// Likes, comment counts and poll results for a page of posts, in a few
// grouped queries (not one per post).
const enrich = async (posts, v) => {
  if (!posts.length) return [];
  const ids = posts.map((p) => p.eventId);
  const me = actorOf(v);
  const pollIds = posts.filter((p) => p.postType === "POLL").map((p) => p.eventId);
  const commentWhere = { postId: { [Op.in]: ids } };
  if (!isNewsManager(v)) commentWhere.status = "VISIBLE";

  const likeCounts = await PostLike.findAll({ attributes: ["postId", [fn("COUNT", col("like_id")), "n"]], where: { postId: { [Op.in]: ids } }, group: ["postId"], raw: true });
  const myLikes = await PostLike.findAll({ attributes: ["postId"], where: { postId: { [Op.in]: ids }, ...me }, raw: true });
  const commentCounts = await PostComment.findAll({ attributes: ["postId", [fn("COUNT", col("comment_id")), "n"]], where: commentWhere, group: ["postId"], raw: true });
  let options = [];
  let votes = [];
  let myVotes = [];
  if (pollIds.length) {
    options = await PollOption.findAll({ where: { postId: { [Op.in]: pollIds } }, order: [["position", "ASC"], ["optionId", "ASC"]], raw: true });
    votes = await PollVote.findAll({ attributes: ["optionId", [fn("COUNT", col("vote_id")), "n"]], where: { postId: { [Op.in]: pollIds } }, group: ["optionId"], raw: true });
    myVotes = await PollVote.findAll({ attributes: ["postId", "optionId"], where: { postId: { [Op.in]: pollIds }, ...me }, raw: true });
  }
  const likes = countBy(likeCounts, "postId");
  const liked = new Set(myLikes.map((r) => r.postId));
  const comments = countBy(commentCounts, "postId");
  const voteCounts = countBy(votes, "optionId");
  const myVote = Object.fromEntries(myVotes.map((r) => [r.postId, r.optionId]));

  return posts.map((p) => {
    const extra = { likeCount: likes[p.eventId] || 0, likedByMe: liked.has(p.eventId), commentCount: comments[p.eventId] || 0 };
    if (p.postType === "POLL") {
      const opts = options.filter((o) => o.postId === p.eventId).map((o) => ({ optionId: o.optionId, label: o.label, votes: voteCounts[o.optionId] || 0 }));
      extra.options = opts;
      extra.totalVotes = opts.reduce((s, o) => s + o.votes, 0);
      extra.myVoteOptionId = myVote[p.eventId] ?? null;
    }
    return serializePost(p, v, extra);
  });
};

const plain = (row) => (typeof row?.toJSON === "function" ? row.toJSON() : row);

// ------------------------------------------------------------------ feed
const FEED_ORDER = [
  ["isPinned", "DESC"],
  literal('COALESCE("published_at", "date"::timestamptz) DESC NULLS LAST'),
  ["eventId", "DESC"],
];

export const listPosts = async (v, query = {}) => {
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), FEED_MAX);
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const and = visibilityWhere(v);
  const type = text(query.type).toUpperCase();
  if (type) {
    if (!POST_TYPES.includes(type)) throw new AppError("Unknown post type.", 400);
    and.push({ postType: type });
  }
  const status = text(query.status).toUpperCase();
  if (status) {
    if (!STATUSES.includes(status)) throw new AppError("Unknown status.", 400);
    and.push({ status });
  } else if (v.type === "OFFICE" && !bool(query.includeArchived, false)) {
    and.push({ status: { [Op.ne]: "ARCHIVED" } });
  }
  const { rows, count } = await Event.findAndCountAll({ where: { [Op.and]: and }, order: FEED_ORDER, limit, offset: (page - 1) * limit });
  return { posts: await enrich(rows.map(plain), v), total: count, page, limit, totalPages: Math.ceil(count / limit) };
};

export const getPost = async (postId, v) => {
  const post = await loadVisible(postId, v);
  const [one] = await enrich([plain(post)], v);
  return one;
};

// ------------------------------------------------------------------ calendar
// GET /events?month=YYYY-MM: published posts with a date that touch the month
// (a multi-day event shows in every month it spans). ?upcoming=1: from today.
export const listEvents = async (v, query = {}) => {
  const and = visibilityWhere(v, { publishedOnly: true });
  and.push({ date: { [Op.ne]: null } });
  const order = [["date", "ASC"], ["eventId", "ASC"]];
  let limit;
  if (query.month !== undefined) {
    const m = MONTH_RE.exec(text(query.month));
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new AppError("Use month=YYYY-MM.", 400);
    const start = `${m[1]}-${m[2]}-01`;
    const last = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
    const end = `${m[1]}-${m[2]}-${String(last).padStart(2, "0")}`;
    and.push({ date: { [Op.lte]: end } }, { [Op.or]: [{ eventEndDate: { [Op.gte]: start } }, { eventEndDate: null, date: { [Op.gte]: start } }] });
  } else {
    const today = new Date().toISOString().slice(0, 10);
    and.push({ [Op.or]: [{ eventEndDate: { [Op.gte]: today } }, { eventEndDate: null, date: { [Op.gte]: today } }] });
    limit = Math.min(Math.max(parseInt(query.limit, 10) || 5, 1), 20);
  }
  const rows = await Event.findAll({ where: { [Op.and]: and }, order, ...(limit ? { limit } : {}), raw: true });
  return rows.map((p) => serializePost(p, v));
};

// ------------------------------------------------------------------ writes
const saveOptions = async (postId, labels, transaction) => {
  await PollOption.destroy({ where: { postId }, transaction });
  for (let i = 0; i < labels.length; i++) {
    await PollOption.create({ postId, label: labels[i], position: i }, { transaction });
  }
};

export const createPost = async (body, v) => {
  if (!isNewsManager(v) && !isPoster(v)) throw new AppError("You do not have permission to perform this action", 403);
  const { postType, values, options } = await validatePost(body, v, null);
  const status = text(body.status || "PUBLISHED").toUpperCase();
  if (!["DRAFT", "PUBLISHED"].includes(status)) throw new AppError("A new post is a draft or published.", 400);
  const now = new Date();
  const id = await sequelize.transaction(async (transaction) => {
    const post = await Event.create(
      {
        ...values,
        postType,
        status,
        isPinned: false,
        createdBy: v.username,
        created_at: now.toISOString(),
        publishedAt: status === "PUBLISHED" ? now : null,
        updatedAt: now,
      },
      { transaction }
    );
    if (options) await saveOptions(post.eventId, options, transaction);
    return post.eventId;
  });
  // B16: tell the post's audience, after the commit, in the background
  // (notifyPostPublished never throws).
  if (status === "PUBLISHED") {
    notifyPostPublished({ ...values, postType, status, createdBy: v.username, eventId: id });
  }
  return getPost(id, v);
};

// AI-8: an accepted AI draft becomes a DRAFT post, inside the caller's
// transaction (the one that marks the draft accepted). Never published here,
// so no B16 notification. Returns the new post id.
export const createDraftPostInTransaction = async (body, v, transaction) => {
  if (!isAdmin(v) && !isClassTeacher(v)) throw new AppError("You do not have permission to perform this action", 403);
  const { postType, values, options } = await validatePost({ ...body, postType: "NEWS" }, v, null);
  const now = new Date();
  const post = await Event.create(
    { ...values, postType, status: "DRAFT", isPinned: false, createdBy: v.username, created_at: now.toISOString(), publishedAt: null, updatedAt: now },
    { transaction }
  );
  if (options) await saveOptions(post.eventId, options, transaction);
  return post.eventId;
};

export const updatePost = async (postId, body, v) => {
  const post = await loadManaged(postId, v);
  const { values, options } = await validatePost(body, v, plain(post));
  await sequelize.transaction(async (transaction) => {
    if (options) {
      const votes = await PollVote.count({ where: { postId: post.eventId }, transaction });
      if (votes > 0) throw new AppError("People have voted: the choices can't change now.", 409);
      await saveOptions(post.eventId, options, transaction);
    }
    await Event.update({ ...values, updatedAt: new Date() }, { where: { eventId: post.eventId }, transaction });
  });
  return getPost(post.eventId, v);
};

export const setStatus = async (postId, status, v) => {
  const post = await loadManaged(postId, v);
  const next = text(status).toUpperCase();
  if (!STATUSES.includes(next)) throw new AppError("Unknown status.", 400);
  const values = { status: next, updatedAt: new Date() };
  if (next === "PUBLISHED" && !post.publishedAt) values.publishedAt = new Date();
  if (next !== "PUBLISHED") values.isPinned = false; // only live posts stay pinned
  await Event.update(values, { where: { eventId: post.eventId } });
  // B16: the first publish only (a draft -> published again doesn't repeat it).
  if (next === "PUBLISHED" && !post.publishedAt) notifyPostPublished({ ...plain(post), ...values });
  return getPost(post.eventId, v);
};

export const setPinned = async (postId, pinned, v) => {
  if (!isNewsManager(v)) throw new AppError("Only a news manager can pin posts.", 403);
  const post = await loadVisible(postId, v);
  const on = bool(pinned, true);
  if (on && post.status !== "PUBLISHED") throw new AppError("Publish the post before pinning it.", 400);
  await Event.update({ isPinned: on, updatedAt: new Date() }, { where: { eventId: post.eventId } });
  return getPost(post.eventId, v);
};

export const deletePost = async (postId, v) => {
  const post = await loadManaged(postId, v);
  await Event.destroy({ where: { eventId: post.eventId } }); // likes, comments, votes go with it (037)
  if (post.imageKey) await storage.remove(post.imageKey);
  return { deleted: 1 };
};

// ------------------------------------------------------------------ image
export const setPostImage = async (postId, file, v) => {
  const post = await loadManaged(postId, v);
  const saved = await saveUpload(file, "postImage");
  try {
    await Event.update({ imageKey: saved.key, updatedAt: new Date() }, { where: { eventId: post.eventId } });
  } catch (e) {
    await storage.remove(saved.key);
    throw e;
  }
  if (post.imageKey && post.imageKey !== saved.key) await storage.remove(post.imageKey);
  return getPost(post.eventId, v);
};

export const removePostImage = async (postId, v) => {
  const post = await loadManaged(postId, v);
  if (post.imageKey) {
    await Event.update({ imageKey: null, updatedAt: new Date() }, { where: { eventId: post.eventId } });
    await storage.remove(post.imageKey);
  }
  return getPost(post.eventId, v);
};

export const getPostImageKey = async (postId, v) => {
  const post = await loadVisible(postId, v);
  if (!post.imageKey) throw new AppError("File not found", 404);
  return post.imageKey;
};

// ------------------------------------------------------------------ likes
// liked = true/false sets the state (safe to repeat); omitted = toggle.
export const setLike = async (postId, v, liked) => {
  const post = await loadInteractive(postId, v);
  const where = { postId: post.eventId, ...actorOf(v) };
  let want = liked === undefined || liked === null ? null : bool(liked, true);
  if (want === null) want = !(await PostLike.findOne({ where, raw: true }));
  if (want) {
    try {
      await PostLike.findOrCreate({ where, defaults: where });
    } catch (e) {
      if (!(e instanceof UniqueConstraintError)) throw e; // a second tap at the same moment
    }
  } else {
    await PostLike.destroy({ where });
  }
  const likeCount = await PostLike.count({ where: { postId: post.eventId } });
  return { liked: want, likeCount };
};

// ------------------------------------------------------------------ comments
const shapeComment = (c, v) => {
  const mine = c.actorType === actorOf(v).actorType && String(c.actorId) === actorOf(v).actorId;
  const out = {
    commentId: c.commentId,
    authorName: c.actorType === "OFFICE" ? "School office" : c.actorName || (c.actorType === "STAFF" ? "Teacher" : "Pupil"),
    authorType: c.actorType,
    body: c.body,
    createdAt: isoDate(c.createdAt),
    mine,
    canDelete: mine || isNewsManager(v),
  };
  if (isNewsManager(v)) {
    out.status = c.status;
    out.hiddenBy = c.hiddenBy ?? null;
  }
  return out;
};

export const listComments = async (postId, v, query = {}) => {
  const post = await loadVisible(postId, v);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), COMMENTS_MAX);
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const where = { postId: post.eventId };
  if (!isNewsManager(v)) where.status = "VISIBLE";
  else if (text(query.status)) where.status = text(query.status).toUpperCase();
  const { rows, count } = await PostComment.findAndCountAll({ where, order: [["createdAt", "ASC"], ["commentId", "ASC"]], limit, offset: (page - 1) * limit, raw: true });
  return { comments: rows.map((c) => shapeComment(c, v)), total: count, page, limit, totalPages: Math.ceil(count / limit) };
};

export const addComment = async (postId, body, v) => {
  const post = await loadInteractive(postId, v);
  if (post.commentsEnabled === false) throw new AppError("Comments are turned off for this post.", 403);
  const b = text(body?.body);
  if (!b) throw new AppError("Write a comment.", 400);
  if (b.length > LIMITS.comment) throw new AppError(`A comment can be at most ${LIMITS.comment} characters.`, 400);
  const c = await PostComment.create({
    postId: post.eventId,
    ...actorOf(v),
    actorName: v.type === "OFFICE" ? null : (v.name || "").slice(0, 120) || null,
    body: b,
    status: "VISIBLE",
  });
  return shapeComment(plain(c), v);
};

const loadComment = async (post, commentId) => {
  const id = Number(commentId);
  const c = Number.isInteger(id) && id > 0 ? await PostComment.findByPk(id) : null;
  if (!c || c.postId !== post.eventId) throw new AppError("Comment not found", 404);
  return c;
};

export const deleteComment = async (postId, commentId, v) => {
  const post = await loadVisible(postId, v);
  const c = await loadComment(post, commentId);
  const me = actorOf(v);
  const mine = c.actorType === me.actorType && String(c.actorId) === me.actorId;
  if (!mine && !isNewsManager(v)) throw new AppError("You can only delete your own comments.", 403);
  await PostComment.destroy({ where: { commentId: c.commentId } });
  return { deleted: 1 };
};

export const setCommentHidden = async (postId, commentId, hidden, v) => {
  if (!isNewsManager(v)) throw new AppError("Only a news manager can hide comments.", 403);
  const post = await loadVisible(postId, v);
  const c = await loadComment(post, commentId);
  const hide = bool(hidden, true);
  await PostComment.update(
    hide ? { status: "HIDDEN", hiddenBy: v.username, hiddenAt: new Date() } : { status: "VISIBLE", hiddenBy: null, hiddenAt: null },
    { where: { commentId: c.commentId } }
  );
  return shapeComment({ ...plain(c), status: hide ? "HIDDEN" : "VISIBLE", hiddenBy: hide ? v.username : null }, v);
};

// ------------------------------------------------------------------ polls
// Results are counts only (who voted is stored, to keep one vote each, but
// never shown).
export const pollResults = async (postId, v) => {
  const post = await loadVisible(postId, v);
  if (post.postType !== "POLL") throw new AppError("This post is not a poll.", 400);
  const [one] = await enrich([plain(post)], v);
  return { postId: one.postId, options: one.options, totalVotes: one.totalVotes, myVoteOptionId: one.myVoteOptionId, pollClosed: one.pollClosed };
};

export const vote = async (postId, optionId, v) => {
  const post = await loadInteractive(postId, v);
  if (post.postType !== "POLL") throw new AppError("This post is not a poll.", 400);
  if (pollClosed(post)) throw new AppError("This poll has closed.", 400);
  const id = Number(optionId);
  const option = Number.isInteger(id) && id > 0 ? await PollOption.findByPk(id, { raw: true }) : null;
  if (!option || option.postId !== post.eventId) throw new AppError("Choose one of the poll's choices.", 400);
  try {
    await PollVote.create({ postId: post.eventId, optionId: option.optionId, ...actorOf(v) });
  } catch (e) {
    if (e instanceof UniqueConstraintError) throw new AppError("You have already voted in this poll.", 409);
    throw e;
  }
  return pollResults(post.eventId, v);
};
