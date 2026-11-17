import { Router } from "express";
import * as posts from "../services/posts.js";
import { sendStoredFile, uploadOne } from "../services/storage.js";
import { authenticateUser } from "../utils/middlewares.js";
import { ADMINISTRATOR, CLASS_TEACHER, HEAD_TEACHER } from "../utils/roles.js";

// B15: news feed, polls and the events calendar, for EVERY kind of login
// (portal pupils and teachers, office logins). Mounted after portalRouter and
// before the management routers. The audience filter and who-may-change-what
// live in services/posts.js; this only builds the viewer from the token.
//
// Only /posts... and /events?month= | ?upcoming= are handled here. A plain
// GET /events (the old office list) falls through to generalRouter.
const router = Router();

const withViewer = (req, res, next) =>
  authenticateUser(req, res, async (err) => {
    if (err) return next(err);
    try {
      req.viewer = await posts.viewerFromUser(req.user);
      return next();
    } catch (e) {
      return next(e);
    }
  });

const send = (fn) => async (req, res, next) => {
  try {
    res.json(await fn(req, res));
  } catch (error) {
    next(error);
  }
};

// The office roles that may write posts; the service narrows Class Teachers to
// their own class and own posts. B10: the Head Teacher manages news like the
// Administrator (posts.isNewsManager).
const writers = (req, res, next) => {
  if (posts.isNewsManager(req.viewer) || posts.isClassTeacher(req.viewer)) return next();
  res.status(403);
  return next(new Error("You do not have permission to perform this action"));
};
writers.allowedRoles = [ADMINISTRATOR, CLASS_TEACHER, HEAD_TEACHER]; // for the router-walk access test

// Calendar paths first: a plain /events is the old list (generalRouter).
const isCalendar = (req) => req.query.month !== undefined || req.query.upcoming !== undefined;
router.get("/events", (req, res, next) => (isCalendar(req) ? next() : next("router")), withViewer, send((req) => posts.listEvents(req.viewer, req.query)));

router.use("/posts", withViewer);

router.get("/posts", send((req) => posts.listPosts(req.viewer, req.query)));
router.post("/posts", writers, send((req) => posts.createPost(req.body, req.viewer)));
router.get("/posts/:id", send((req) => posts.getPost(req.params.id, req.viewer)));
router.put("/posts/:id", writers, send((req) => posts.updatePost(req.params.id, req.body, req.viewer)));
router.delete("/posts/:id", writers, send((req) => posts.deletePost(req.params.id, req.viewer)));
router.post("/posts/:id/publish", writers, send((req) => posts.setStatus(req.params.id, "PUBLISHED", req.viewer)));
router.post("/posts/:id/draft", writers, send((req) => posts.setStatus(req.params.id, "DRAFT", req.viewer)));
router.post("/posts/:id/archive", writers, send((req) => posts.setStatus(req.params.id, "ARCHIVED", req.viewer)));
router.post("/posts/:id/pin", writers, send((req) => posts.setPinned(req.params.id, req.body?.pinned, req.viewer)));

// Image: checks run before the upload is read (role, then the post).
const canChangeImage = async (req, res, next) => {
  try {
    const post = await posts.getPost(req.params.id, req.viewer);
    if (!post.canManage) {
      res.status(403);
      return next(new Error("You can only change your own posts."));
    }
    return next();
  } catch (e) {
    return next(e);
  }
};
router.get(
  "/posts/:id/image",
  async (req, res, next) => {
    try {
      const key = await posts.getPostImageKey(req.params.id, req.viewer);
      await sendStoredFile(res, { key, name: `post-${req.params.id}.${key.split(".").pop()}`, cache: "private, max-age=300" });
    } catch (e) {
      next(e);
    }
  }
);
router.post("/posts/:id/image", writers, canChangeImage, uploadOne("postImage"), send((req) => posts.setPostImage(req.params.id, req.file, req.viewer)));
router.delete("/posts/:id/image", writers, send((req) => posts.removePostImage(req.params.id, req.viewer)));

// Likes, comments, polls: anyone who can see the (published) post.
router.post("/posts/:id/like", send((req) => posts.setLike(req.params.id, req.viewer, req.body?.liked)));
router.get("/posts/:id/comments", send((req) => posts.listComments(req.params.id, req.viewer, req.query)));
router.post("/posts/:id/comments", send((req) => posts.addComment(req.params.id, req.body, req.viewer)));
router.delete("/posts/:id/comments/:commentId", send((req) => posts.deleteComment(req.params.id, req.params.commentId, req.viewer)));
router.post("/posts/:id/comments/:commentId/hide", send((req) => posts.setCommentHidden(req.params.id, req.params.commentId, req.body?.hidden, req.viewer)));
router.get("/posts/:id/results", send((req) => posts.pollResults(req.params.id, req.viewer)));
router.post("/posts/:id/vote", send((req) => posts.vote(req.params.id, req.body?.optionId, req.viewer)));

export { router as newsRouter };
