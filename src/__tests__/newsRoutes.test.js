// B15: who reaches the news routes (service stubbed, no DB).
process.env.JWT_KEY = "test-secret";
process.env.NODE_ENV = "test";

import jwt from "jsonwebtoken";
import request from "supertest";

jest.mock("../services/posts.js", () => {
  const real = jest.requireActual("../services/posts.js");
  const viewer = async (user) => {
    if (user.category) return { type: "OFFICE", category: user.category, username: user.username, teacherId: user.teacherId ?? null };
    if (user.userRole === "STU") return { type: "STUDENT", id: user.id, classId: 5 };
    if (user.userRole === "STAFF") return { type: "STAFF", id: user.id };
    const e = new Error("You do not have permission to perform this action");
    e.statusCode = 403;
    throw e;
  };
  const echo = (name) => jest.fn(async (...args) => ({ name, viewer: args.find((a) => a && a.type) }));
  return {
    __esModule: true,
    isAdmin: real.isAdmin,
    isNewsManager: real.isNewsManager,
    isClassTeacher: real.isClassTeacher,
    viewerFromUser: jest.fn(viewer),
    listPosts: echo("listPosts"),
    getPost: jest.fn(async () => ({ postId: 1, canManage: true })),
    createPost: echo("createPost"),
    updatePost: echo("updatePost"),
    deletePost: echo("deletePost"),
    setStatus: echo("setStatus"),
    setPinned: echo("setPinned"),
    setPostImage: echo("setPostImage"),
    removePostImage: echo("removePostImage"),
    getPostImageKey: jest.fn(async () => "photos/2026/x.jpg"),
    setLike: echo("setLike"),
    listComments: echo("listComments"),
    addComment: echo("addComment"),
    deleteComment: echo("deleteComment"),
    setCommentHidden: echo("setCommentHidden"),
    pollResults: echo("pollResults"),
    vote: echo("vote"),
    listEvents: echo("listEvents"),
  };
});
jest.mock("../services/news.js", () => ({
  __esModule: true,
  getNews: jest.fn(async () => [{ eventId: 1, name: "PTA" }]),
  createEvent: jest.fn(),
  editEvent: jest.fn(),
  removeEvent: jest.fn(),
}));

const app = require("../index.js").default;
const svc = require("../services/posts.js");
const news = require("../services/news.js");

const sign = (p) => jwt.sign(p, "test-secret", { algorithm: "HS256", expiresIn: "1h" });
const student = sign({ id: 7, userRole: "STU" });
const teacher = sign({ id: "3", userRole: "STAFF" });
const admin = sign({ category: "Administrator", username: "admin", teacherId: null });
const classTeacher = sign({ category: "Class Teacher", username: "ct", teacherId: 3 });
const accountant = sign({ category: "Accountant", username: "acc", teacherId: null });
const auth = (r, t) => (t ? r.set("Authorization", `Bearer ${t}`) : r);

beforeEach(() => jest.clearAllMocks());

describe("/posts", () => {
  it.each([["pupil", student, "STUDENT"], ["teacher", teacher, "STAFF"], ["office", accountant, "OFFICE"]])("a %s reads the feed as themselves", async (_l, t, type) => {
    const res = await auth(request(app).get("/posts"), t);
    expect(res.status).toBe(200);
    expect(res.body.viewer.type).toBe(type);
  });

  it("no token = 401; unknown portal role = 403", async () => {
    expect((await request(app).get("/posts")).status).toBe(401);
    expect((await auth(request(app).get("/posts"), sign({ id: 1, userRole: "PARENT" }))).status).toBe(403);
  });

  it.each([
    ["post", "/posts"],
    ["put", "/posts/1"],
    ["delete", "/posts/1"],
    ["post", "/posts/1/publish"],
    ["post", "/posts/1/archive"],
    ["post", "/posts/1/pin"],
    ["post", "/posts/1/image"],
    ["delete", "/posts/1/image"],
  ])("pupils, teachers and Accountants can't %s %s", async (method, path) => {
    for (const t of [student, teacher, accountant]) {
      expect((await auth(request(app)[method](path), t).send({})).status).toBe(403);
    }
  });

  it("Administrator and Class Teacher reach the writes (the service scopes them)", async () => {
    for (const t of [admin, classTeacher]) {
      expect((await auth(request(app).post("/posts"), t).send({ title: "x" })).status).toBe(200);
    }
    expect(svc.createPost).toHaveBeenCalledTimes(2);
  });

  it("everyone reaches like, comment and vote (the service checks the audience)", async () => {
    for (const t of [student, teacher, accountant]) {
      expect((await auth(request(app).post("/posts/1/like"), t).send({ liked: true })).status).toBe(200);
      expect((await auth(request(app).post("/posts/1/comments"), t).send({ body: "hi" })).status).toBe(200);
      expect((await auth(request(app).post("/posts/1/vote"), t).send({ optionId: 2 })).status).toBe(200);
    }
    expect(svc.setLike).toHaveBeenCalledWith("1", expect.objectContaining({ type: "STUDENT" }), true);
    expect(svc.vote).toHaveBeenCalledWith("1", 2, expect.objectContaining({ type: "STUDENT" }));
  });
});

describe("/events", () => {
  it("?month= is the calendar, for portal and office tokens", async () => {
    for (const t of [student, admin]) {
      const res = await auth(request(app).get("/events?month=2026-02"), t);
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("listEvents");
    }
  });
  it("plain /events is still the old office list; portal tokens can't use it", async () => {
    const res = await auth(request(app).get("/events"), admin);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ eventId: 1, name: "PTA" }]);
    expect(svc.listEvents).not.toHaveBeenCalled();
    expect((await auth(request(app).get("/events"), student)).status).toBe(403);
  });
});

describe("old /news", () => {
  it("an Accountant passes their viewer too (no drafts)", async () => {
    expect((await auth(request(app).get("/news"), accountant)).status).toBe(200);
    expect(news.getNews).toHaveBeenLastCalledWith(expect.objectContaining({ viewer: expect.objectContaining({ type: "OFFICE", category: "Accountant" }) }));
  });

  it("portal callers pass their viewer (audience filter); the Administrator doesn't", async () => {
    expect((await auth(request(app).get("/news"), student)).status).toBe(200);
    expect(news.getNews).toHaveBeenLastCalledWith(expect.objectContaining({ viewer: expect.objectContaining({ type: "STUDENT" }) }));
    expect((await auth(request(app).get("/news"), admin)).status).toBe(200);
    expect(news.getNews).toHaveBeenLastCalledWith(expect.objectContaining({ viewer: null }));
  });
});
