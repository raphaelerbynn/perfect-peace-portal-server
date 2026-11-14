// B16 hook in B15: a post notifies its audience on its FIRST publish only.
jest.mock("../config/database.js", () => ({
  __esModule: true,
  default: { transaction: jest.fn(async (fn) => fn({})), query: jest.fn() },
}));
jest.mock("../services/storage.js", () => ({ __esModule: true, saveUpload: jest.fn(), storage: { remove: jest.fn() } }));
jest.mock("../services/notify.js", () => ({ __esModule: true, notifyPostPublished: jest.fn(async () => null) }));
jest.mock("../models/index.js", () => {
  const model = () => ({
    findAll: jest.fn(async () => []),
    findOne: jest.fn(async () => null),
    findByPk: jest.fn(async () => null),
    findAndCountAll: jest.fn(async () => ({ rows: [], count: 0 })),
    create: jest.fn(async (v) => ({ eventId: 10, ...v })),
    update: jest.fn(async () => [1]),
    destroy: jest.fn(async () => 1),
    count: jest.fn(async () => 0),
  });
  return { __esModule: true, Event: model(), PostLike: model(), PostComment: model(), PollOption: model(), PollVote: model(), Class: model(), Student: model(), Teacher: model() };
});

import { Event } from "../models/index.js";
import { notifyPostPublished } from "../services/notify.js";
import * as P from "../services/posts.js";

const admin = { type: "OFFICE", category: "Administrator", username: "admin", teacherId: null };
const row = (over = {}) => ({ eventId: 10, name: "Sports day", description: "Come", postType: "NEWS", status: "DRAFT", audience: "ALL", audienceClassIds: null, createdBy: "admin", publishedAt: null, ...over });

beforeEach(() => {
  jest.clearAllMocks();
  Event.findByPk.mockResolvedValue(row({ status: "PUBLISHED", publishedAt: new Date() }));
});

it("create published -> notify with the post; create draft -> no notify", async () => {
  await P.createPost({ title: "Sports day", body: "Come", status: "PUBLISHED" }, admin);
  expect(notifyPostPublished).toHaveBeenCalledTimes(1);
  expect(notifyPostPublished.mock.calls[0][0]).toMatchObject({ eventId: 10, name: "Sports day", audience: "ALL", createdBy: "admin", postType: "NEWS" });
  await P.createPost({ title: "Draft", body: "x", status: "DRAFT" }, admin);
  expect(notifyPostPublished).toHaveBeenCalledTimes(1);
});

it("publishing a draft notifies; re-publishing an archived post doesn't", async () => {
  Event.findByPk.mockResolvedValueOnce(row());
  await P.setStatus(10, "PUBLISHED", admin);
  expect(notifyPostPublished).toHaveBeenCalledTimes(1);
  expect(notifyPostPublished.mock.calls[0][0]).toMatchObject({ eventId: 10, status: "PUBLISHED" });
  Event.findByPk.mockResolvedValueOnce(row({ status: "ARCHIVED", publishedAt: new Date("2026-11-01") }));
  await P.setStatus(10, "PUBLISHED", admin);
  expect(notifyPostPublished).toHaveBeenCalledTimes(1);
  Event.findByPk.mockResolvedValueOnce(row({ status: "PUBLISHED", publishedAt: new Date() }));
  await P.setStatus(10, "ARCHIVED", admin);
  expect(notifyPostPublished).toHaveBeenCalledTimes(1);
});
