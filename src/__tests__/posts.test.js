// B15: news feed rules (models mocked, no DB): audience filter on every read,
// one vote per voter, comment hide, idempotent like, the old /news shape.
jest.mock("../config/database.js", () => ({
  __esModule: true,
  default: { transaction: jest.fn(async (fn) => fn({})), query: jest.fn() },
}));
jest.mock("../services/storage.js", () => ({
  __esModule: true,
  saveUpload: jest.fn(async () => ({ key: "photos/2026/" + "a".repeat(32) + ".jpg" })),
  storage: { remove: jest.fn(async () => {}) },
}));
jest.mock("../models/index.js", () => {
  const model = () => ({
    findAll: jest.fn(async () => []),
    findOne: jest.fn(async () => null),
    findByPk: jest.fn(async () => null),
    findAndCountAll: jest.fn(async () => ({ rows: [], count: 0 })),
    findOrCreate: jest.fn(async () => [{}, true]),
    create: jest.fn(async (v) => ({ ...v })),
    update: jest.fn(async () => [1]),
    destroy: jest.fn(async () => 1),
    count: jest.fn(async () => 0),
  });
  return {
    __esModule: true,
    Event: model(),
    PostLike: model(),
    PostComment: model(),
    PollOption: model(),
    PollVote: model(),
    Class: model(),
    Student: model(),
    Teacher: model(),
  };
});

import { Op, UniqueConstraintError } from "sequelize";
import { Class, Event, PollOption, PollVote, PostComment, PostLike, Student } from "../models/index.js";
import * as P from "../services/posts.js";
import { getNews } from "../services/news.js";
import { officeUser } from "../testSupport/officeUser.js";

// B10: office viewers carry their role's permissions (posts.viewerFromUser).
const admin = { type: "OFFICE", ...officeUser("Administrator", { username: "admin", teacherId: null }) };
const classTeacher = { type: "OFFICE", ...officeUser("Class Teacher", { username: "ct", teacherId: 3 }) };
const accountant = { type: "OFFICE", ...officeUser("Accountant", { username: "acc", teacherId: null }) };
const teacher = { type: "STAFF", id: 3, name: "Kofi Mensah" };
const pupil = (classId = 5) => ({ type: "STUDENT", id: 7, classId, name: "Ama Owusu" });

const post = (over = {}) => ({
  eventId: 10,
  name: "Sports day",
  description: "Come along",
  postType: "NEWS",
  status: "PUBLISHED",
  audience: "ALL",
  audienceClassIds: null,
  commentsEnabled: true,
  isPinned: false,
  createdBy: "admin",
  imageKey: null,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe("audience filter", () => {
  it.each([
    ["ALL to a pupil", post(), pupil(), true],
    ["STAFF to a pupil", post({ audience: "STAFF" }), pupil(), false],
    ["STAFF to a teacher", post({ audience: "STAFF" }), teacher, true],
    ["STAFF to an accountant", post({ audience: "STAFF" }), accountant, true],
    ["their class to a pupil", post({ audience: "CLASSES", audienceClassIds: [4, 5] }), pupil(5), true],
    ["another class to a pupil", post({ audience: "CLASSES", audienceClassIds: [4] }), pupil(5), false],
    ["a class post to a pupil with no class", post({ audience: "CLASSES", audienceClassIds: [4] }), pupil(null), false],
    ["a class post to a teacher", post({ audience: "CLASSES", audienceClassIds: [4] }), teacher, true],
    ["a draft to a pupil", post({ status: "DRAFT" }), pupil(), false],
    ["a draft to a teacher", post({ status: "DRAFT" }), teacher, false],
    ["an archived post to a pupil", post({ status: "ARCHIVED" }), pupil(), false],
    ["a draft to the Administrator", post({ status: "DRAFT", createdBy: "someone" }), admin, true],
    ["a Class Teacher's own draft", post({ status: "DRAFT", createdBy: "ct" }), classTeacher, true],
    ["someone else's draft to a Class Teacher", post({ status: "DRAFT", createdBy: "admin" }), classTeacher, false],
  ])("%s -> %p", (_l, p, v, expected) => {
    expect(P.canSee(p, v)).toBe(expected);
  });

  it("the feed query for a pupil: published, ALL or their class only", () => {
    const where = P.visibilityWhere(pupil(5));
    expect(where).toEqual([
      { [Op.or]: [{ audience: "ALL" }, { audience: "CLASSES", audienceClassIds: { [Op.contains]: [5] } }] },
      { status: "PUBLISHED" },
    ]);
  });

  it("a pupil with no class gets ALL only", () => {
    expect(P.visibilityWhere(pupil(null))[0]).toEqual({ [Op.or]: [{ audience: "ALL" }] });
  });

  it("staff see every audience; the Administrator every status", () => {
    expect(P.visibilityWhere(teacher)).toEqual([{ status: "PUBLISHED" }]);
    expect(P.visibilityWhere(admin)).toEqual([]);
    expect(P.visibilityWhere(classTeacher)).toEqual([{ [Op.or]: [{ status: "PUBLISHED" }, { createdBy: "ct" }] }]);
  });

  it("listPosts sends the filter to the database and paginates", async () => {
    Event.findAndCountAll.mockResolvedValue({ rows: [post()], count: 1 });
    const res = await P.listPosts(pupil(5), { limit: 500 });
    const q = Event.findAndCountAll.mock.calls[0][0];
    expect(q.where[Op.and]).toEqual(P.visibilityWhere(pupil(5)));
    expect(q.limit).toBe(50);
    expect(res).toMatchObject({ total: 1, page: 1, limit: 50 });
    expect(res.posts[0]).toMatchObject({ postId: 10, title: "Sports day", hasImage: false });
    expect(res.posts[0]).not.toHaveProperty("createdBy");
    expect(res.posts[0]).not.toHaveProperty("audienceClassIds");
  });

  it.each([
    ["comments", () => P.listComments(10, pupil(5))],
    ["add a comment", () => P.addComment(10, { body: "hi" }, pupil(5))],
    ["like", () => P.setLike(10, pupil(5), true)],
    ["vote", () => P.vote(10, 1, pupil(5))],
    ["results", () => P.pollResults(10, pupil(5))],
    ["image", () => P.getPostImageKey(10, pupil(5))],
    ["get one", () => P.getPost(10, pupil(5))],
  ])("%s on a post the pupil can't see is a 404", async (_l, call) => {
    Event.findByPk.mockResolvedValue(post({ audience: "CLASSES", audienceClassIds: [9], postType: "POLL" }));
    await expect(call()).rejects.toMatchObject({ statusCode: 404 });
    expect(PostComment.create).not.toHaveBeenCalled();
    expect(PostLike.findOrCreate).not.toHaveBeenCalled();
    expect(PollVote.create).not.toHaveBeenCalled();
  });

  it("calendar: published only, months spanned by multi-day events, audience applied", async () => {
    await P.listEvents(pupil(5), { month: "2026-02" });
    const and = Event.findAll.mock.calls[0][0].where[Op.and];
    expect(and).toContainEqual({ status: "PUBLISHED" });
    expect(and).toContainEqual({ date: { [Op.lte]: "2026-02-28" } });
    expect(and).toContainEqual({ [Op.or]: [{ eventEndDate: { [Op.gte]: "2026-02-01" } }, { eventEndDate: null, date: { [Op.gte]: "2026-02-01" } }] });
    expect(and[0]).toEqual(P.visibilityWhere(pupil(5))[0]);
    await expect(P.listEvents(admin, { month: "2026-13" })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("the Administrator's calendar has no drafts", async () => {
    await P.listEvents(admin, { month: "2026-02" });
    expect(Event.findAll.mock.calls[0][0].where[Op.and]).toContainEqual({ status: "PUBLISHED" });
  });
});

describe("one vote per voter", () => {
  const poll = post({ postType: "POLL" });
  beforeEach(() => {
    Event.findByPk.mockResolvedValue(poll);
    PollOption.findByPk.mockResolvedValue({ optionId: 1, postId: 10 });
  });

  it("first vote is saved for the actor", async () => {
    await P.vote(10, 1, pupil());
    expect(PollVote.create).toHaveBeenCalledWith({ postId: 10, optionId: 1, actorType: "STUDENT", actorId: "7" });
  });

  it("a second vote (the unique key) is a 409", async () => {
    PollVote.create.mockRejectedValueOnce(new UniqueConstraintError({}));
    await expect(P.vote(10, 1, pupil())).rejects.toMatchObject({ statusCode: 409 });
  });

  it("a choice from another poll is refused", async () => {
    PollOption.findByPk.mockResolvedValue({ optionId: 2, postId: 99 });
    await expect(P.vote(10, 2, pupil())).rejects.toMatchObject({ statusCode: 400 });
  });

  it("a closed poll is refused", async () => {
    Event.findByPk.mockResolvedValue({ ...poll, pollClosesAt: new Date(Date.now() - 1000) });
    await expect(P.vote(10, 1, pupil())).rejects.toMatchObject({ statusCode: 400 });
  });

  it("not a poll is refused", async () => {
    Event.findByPk.mockResolvedValue(post());
    await expect(P.vote(10, 1, pupil())).rejects.toMatchObject({ statusCode: 400 });
  });

  it("a draft poll takes no votes", async () => {
    Event.findByPk.mockResolvedValue({ ...poll, status: "DRAFT" });
    await expect(P.vote(10, 1, admin)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("results are counts only, with my choice", async () => {
    PollOption.findAll.mockResolvedValue([{ optionId: 1, postId: 10, label: "Yes" }, { optionId: 2, postId: 10, label: "No" }]);
    PollVote.findAll.mockResolvedValueOnce([{ optionId: 1, n: "3" }]).mockResolvedValueOnce([{ postId: 10, optionId: 1 }]);
    const r = await P.pollResults(10, pupil());
    expect(r).toEqual({
      postId: 10,
      options: [{ optionId: 1, label: "Yes", votes: 3 }, { optionId: 2, label: "No", votes: 0 }],
      totalVotes: 3,
      myVoteOptionId: 1,
      pollClosed: false,
    });
  });

  it("choices can't change once people have voted", async () => {
    PollVote.count.mockResolvedValue(2);
    await expect(P.updatePost(10, { options: ["A", "B"] }, admin)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("likes", () => {
  beforeEach(() => Event.findByPk.mockResolvedValue(post()));

  it("liking twice keeps one like (idempotent)", async () => {
    PostLike.count.mockResolvedValue(1);
    expect(await P.setLike(10, pupil(), true)).toEqual({ liked: true, likeCount: 1 });
    expect(await P.setLike(10, pupil(), true)).toEqual({ liked: true, likeCount: 1 });
    expect(PostLike.findOrCreate).toHaveBeenCalledWith({
      where: { postId: 10, actorType: "STUDENT", actorId: "7" },
      defaults: { postId: 10, actorType: "STUDENT", actorId: "7" },
    });
    expect(PostLike.destroy).not.toHaveBeenCalled();
  });

  it("two taps at once: the unique key clash still means liked", async () => {
    PostLike.findOrCreate.mockRejectedValueOnce(new UniqueConstraintError({}));
    PostLike.count.mockResolvedValue(1);
    expect(await P.setLike(10, pupil(), true)).toEqual({ liked: true, likeCount: 1 });
  });

  it("unlike twice is fine", async () => {
    PostLike.count.mockResolvedValue(0);
    expect(await P.setLike(10, teacher, false)).toEqual({ liked: false, likeCount: 0 });
    expect(await P.setLike(10, teacher, false)).toEqual({ liked: false, likeCount: 0 });
    expect(PostLike.destroy).toHaveBeenCalledWith({ where: { postId: 10, actorType: "STAFF", actorId: "3" } });
  });

  it("no liked value toggles", async () => {
    PostLike.findOne.mockResolvedValueOnce({ likeId: 1 });
    expect((await P.setLike(10, pupil())).liked).toBe(false);
    PostLike.findOne.mockResolvedValueOnce(null);
    expect((await P.setLike(10, pupil())).liked).toBe(true);
  });
});

describe("comments", () => {
  beforeEach(() => Event.findByPk.mockResolvedValue(post()));

  it("a pupil comments; the name is kept, the id is not sent", async () => {
    const c = await P.addComment(10, { body: "  Great!  " }, pupil());
    expect(PostComment.create).toHaveBeenCalledWith(
      expect.objectContaining({ postId: 10, actorType: "STUDENT", actorId: "7", actorName: "Ama Owusu", body: "Great!", status: "VISIBLE" })
    );
    expect(c).toMatchObject({ authorName: "Ama Owusu", mine: true, canDelete: true });
    expect(c).not.toHaveProperty("actorId");
  });

  it("comments switched off for the post: 403", async () => {
    Event.findByPk.mockResolvedValue(post({ commentsEnabled: false }));
    await expect(P.addComment(10, { body: "hi" }, pupil())).rejects.toMatchObject({ statusCode: 403 });
  });

  it("empty and too long are refused", async () => {
    await expect(P.addComment(10, { body: "  " }, pupil())).rejects.toMatchObject({ statusCode: 400 });
    await expect(P.addComment(10, { body: "x".repeat(1001) }, pupil())).rejects.toMatchObject({ statusCode: 400 });
  });

  it("pupils only read VISIBLE comments; the Administrator reads all", async () => {
    await P.listComments(10, pupil());
    expect(PostComment.findAndCountAll.mock.calls[0][0].where).toEqual({ postId: 10, status: "VISIBLE" });
    await P.listComments(10, admin);
    expect(PostComment.findAndCountAll.mock.calls[1][0].where).toEqual({ postId: 10 });
  });

  it("the Administrator hides and shows a comment", async () => {
    PostComment.findByPk.mockResolvedValue({ commentId: 4, postId: 10, actorType: "STUDENT", actorId: "7", body: "x", status: "VISIBLE" });
    const c = await P.setCommentHidden(10, 4, true, admin);
    expect(PostComment.update).toHaveBeenCalledWith(expect.objectContaining({ status: "HIDDEN", hiddenBy: "admin" }), { where: { commentId: 4 } });
    expect(c.status).toBe("HIDDEN");
    await P.setCommentHidden(10, 4, false, admin);
    expect(PostComment.update).toHaveBeenLastCalledWith({ status: "VISIBLE", hiddenBy: null, hiddenAt: null }, { where: { commentId: 4 } });
  });

  it("nobody else may hide comments", async () => {
    for (const v of [classTeacher, accountant, teacher, pupil()]) {
      await expect(P.setCommentHidden(10, 4, true, v)).rejects.toMatchObject({ statusCode: 403 });
    }
  });

  it("a comment from another post is a 404", async () => {
    PostComment.findByPk.mockResolvedValue({ commentId: 4, postId: 11 });
    await expect(P.setCommentHidden(10, 4, true, admin)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("only the author (or the Administrator) deletes a comment", async () => {
    PostComment.findByPk.mockResolvedValue({ commentId: 4, postId: 10, actorType: "STUDENT", actorId: "7" });
    await expect(P.deleteComment(10, 4, { ...pupil(), id: 8 })).rejects.toMatchObject({ statusCode: 403 });
    await expect(P.deleteComment(10, 4, teacher)).rejects.toMatchObject({ statusCode: 403 });
    expect(await P.deleteComment(10, 4, pupil())).toEqual({ deleted: 1 });
    expect(await P.deleteComment(10, 4, admin)).toEqual({ deleted: 1 });
  });
});

describe("writing posts", () => {
  it("validation: event needs a date, end after start, poll needs 2-10 distinct choices", async () => {
    await expect(P.validatePost({ postType: "EVENT", title: "Open day", body: "x" }, admin)).rejects.toMatchObject({ statusCode: 400 });
    await expect(P.validatePost({ postType: "EVENT", title: "Trip", body: "x", eventDate: "2026-03-05", eventEndDate: "2026-03-04" }, admin)).rejects.toMatchObject({ statusCode: 400 });
    await expect(P.validatePost({ postType: "EVENT", title: "Trip", body: "x", eventDate: "2026-02-30" }, admin)).rejects.toMatchObject({ statusCode: 400 });
    await expect(P.validatePost({ postType: "POLL", title: "Q", options: ["Yes"] }, admin)).rejects.toMatchObject({ statusCode: 400 });
    await expect(P.validatePost({ postType: "POLL", title: "Q", options: ["Yes", "yes"] }, admin)).rejects.toMatchObject({ statusCode: 400 });
    await expect(P.validatePost({ postType: "NEWS", title: "", body: "x" }, admin)).rejects.toMatchObject({ statusCode: 400 });
    const ok = await P.validatePost({ postType: "POLL", title: "Uniform?", options: [" Yes ", "No"] }, admin);
    expect(ok.options).toEqual(["Yes", "No"]);
    expect(ok.values.audience).toBe("ALL");
  });

  it("CLASSES needs real classes", async () => {
    Class.count.mockResolvedValue(1);
    await expect(P.validatePost({ title: "t", body: "b", audience: "CLASSES", audienceClassIds: [1, 2] }, admin)).rejects.toMatchObject({ statusCode: 400 });
    Class.count.mockResolvedValue(2);
    const ok = await P.validatePost({ title: "t", body: "b", audience: "CLASSES", audienceClassIds: [2, 1, 2] }, admin);
    expect(ok.values.audienceClassIds).toEqual([1, 2]);
  });

  it("a Class Teacher posts to their own class only", async () => {
    Class.findOne.mockResolvedValue({ classId: 5 });
    const ok = await P.validatePost({ title: "t", body: "b" }, classTeacher);
    expect(ok.values).toMatchObject({ audience: "CLASSES", audienceClassIds: [5] });
    await expect(P.validatePost({ title: "t", body: "b", audience: "ALL" }, classTeacher)).rejects.toMatchObject({ statusCode: 403 });
    await expect(P.validatePost({ title: "t", body: "b", audience: "CLASSES", audienceClassIds: [6] }, classTeacher)).rejects.toMatchObject({ statusCode: 403 });
    Class.findOne.mockResolvedValue(null);
    await expect(P.validatePost({ title: "t", body: "b" }, classTeacher)).rejects.toMatchObject({ statusCode: 403 });
  });

  it("an Accountant can't post", async () => {
    await expect(P.createPost({ title: "t", body: "b" }, accountant)).rejects.toMatchObject({ statusCode: 403 });
  });

  it("a Class Teacher can't change someone else's post", async () => {
    Event.findByPk.mockResolvedValue(post({ createdBy: "admin" }));
    await expect(P.updatePost(10, { title: "x" }, classTeacher)).rejects.toMatchObject({ statusCode: 403 });
    await expect(P.deletePost(10, classTeacher)).rejects.toMatchObject({ statusCode: 403 });
    await expect(P.setStatus(10, "ARCHIVED", classTeacher)).rejects.toMatchObject({ statusCode: 403 });
  });

  it("archiving unpins; only the Administrator pins, and only published posts", async () => {
    Event.findByPk.mockResolvedValue(post({ isPinned: true }));
    await P.setStatus(10, "ARCHIVED", admin);
    expect(Event.update).toHaveBeenCalledWith(expect.objectContaining({ status: "ARCHIVED", isPinned: false }), { where: { eventId: 10 } });
    await expect(P.setPinned(10, true, classTeacher)).rejects.toMatchObject({ statusCode: 403 });
    Event.findByPk.mockResolvedValue(post({ status: "DRAFT" }));
    await expect(P.setPinned(10, true, admin)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("create records the author and the publish time; poll choices saved in order", async () => {
    Event.create.mockResolvedValue({ eventId: 12 });
    Event.findByPk.mockResolvedValue(post({ eventId: 12, postType: "POLL" }));
    await P.createPost({ postType: "POLL", title: "Uniform?", options: ["Yes", "No"] }, admin);
    expect(Event.create.mock.calls[0][0]).toMatchObject({ postType: "POLL", status: "PUBLISHED", createdBy: "admin", name: "Uniform?" });
    expect(Event.create.mock.calls[0][0].publishedAt).toBeInstanceOf(Date);
    expect(PollOption.create.mock.calls.map((c) => c[0])).toEqual([
      { postId: 12, label: "Yes", position: 0 },
      { postId: 12, label: "No", position: 1 },
    ]);
  });

  it("delete removes the stored image too", async () => {
    const storage = require("../services/storage.js").storage;
    Event.findByPk.mockResolvedValue(post({ imageKey: "photos/2026/" + "b".repeat(32) + ".jpg" }));
    await P.deletePost(10, admin);
    expect(Event.destroy).toHaveBeenCalledWith({ where: { eventId: 10 } });
    expect(storage.remove).toHaveBeenCalledWith("photos/2026/" + "b".repeat(32) + ".jpg");
  });
});

describe("viewer from the token", () => {
  it("a pupil's class comes from the database", async () => {
    Student.findByPk.mockResolvedValue({ studentId: 7, classId: 5, fName: "Ama", lName: "Owusu", isDeleted: false });
    expect(await P.viewerFromUser({ id: 7, userRole: "STU", classId: 99 })).toEqual({ type: "STUDENT", id: 7, classId: 5, name: "Ama Owusu" });
  });
  it("a deleted teacher is refused", async () => {
    const { Teacher } = require("../models/index.js");
    Teacher.findByPk.mockResolvedValue({ teacherId: 3, isDeleted: true });
    await expect(P.viewerFromUser({ id: 3, userRole: "STAFF" })).rejects.toMatchObject({ statusCode: 403 });
  });

  it("office (not Administrator) on the old list: no other people's drafts", async () => {
    Event.findAll.mockResolvedValue([]);
    await getNews({ viewer: accountant });
    expect(Event.findAll.mock.calls[0][0].where[Op.and]).toEqual([{ status: "PUBLISHED" }, { postType: { [Op.ne]: "POLL" } }]);
  });

  it("an archived pupil and an unknown role are refused", async () => {
    Student.findByPk.mockResolvedValue({ studentId: 7, isDeleted: true });
    await expect(P.viewerFromUser({ id: 7, userRole: "STU" })).rejects.toMatchObject({ statusCode: 403 });
    await expect(P.viewerFromUser({ id: 1, userRole: "PARENT" })).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("old /news shape", () => {
  const row = { eventId: 1, name: "PTA", description: "Termly", date: "2026-02-20", time: "10:00", created_at: "1731568000000", postType: "NEWS", status: "PUBLISHED", imageKey: "photos/2026/x.jpg", audienceClassIds: [5], createdBy: "admin" };

  it("portal callers get the same fields, only posts they may see, no internal keys", async () => {
    Event.findAll.mockResolvedValue([{ toJSON: () => ({ ...row }) }]);
    const out = await getNews({ viewer: pupil(5) });
    expect(Event.findAll.mock.calls[0][0].where[Op.and]).toEqual([...P.visibilityWhere(pupil(5)), { postType: { [Op.ne]: "POLL" } }]);
    expect(out).toEqual([{ eventId: 1, name: "PTA", description: "Termly", date: "2026-02-20", time: "10:00", created_at: "2024-11-14T07:06:40.000Z", postType: "NEWS" }]);
  });

  it("office callers: every row, as before, still without internal keys", async () => {
    Event.findAll.mockResolvedValue([{ toJSON: () => ({ ...row }) }]);
    const out = await getNews();
    expect(Event.findAll.mock.calls[0][0].where).toBeUndefined();
    expect(out[0]).toMatchObject({ eventId: 1, name: "PTA", status: "PUBLISHED" });
    expect(out[0]).not.toHaveProperty("imageKey");
  });
});
