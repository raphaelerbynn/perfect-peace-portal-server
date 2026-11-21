// A1 server follow-ups: the portal never gets a null subject name in /result,
// and news `created_at` always comes back as an ISO timestamp (or null).
jest.mock("../config/database.js", () => ({
  __esModule: true,
  default: { query: jest.fn(), QueryTypes: { SELECT: "SELECT" }, define: jest.fn(() => ({})), literal: jest.fn() },
}));
jest.mock("../models/index.js", () => ({ __esModule: true, Event: { findAll: jest.fn(), create: jest.fn() } }));

import sequelize from "../config/database.js";
import { Event } from "../models/index.js";
import { getResults, REMOVED_SUBJECT_LABEL } from "../services/results.js";
import { createEvent, getNews, normalizeCreatedAt } from "../services/news.js";

describe("GET /result subject name", () => {
  it("falls back to a label when the subject was deleted", async () => {
    sequelize.query.mockResolvedValue([]);
    await getResults(12);
    const [sql, opts] = sequelize.query.mock.calls[0];
    expect(sql).toContain("COALESCE(subj.name, :removedLabel) AS name1");
    expect(opts.replacements).toEqual({ indexNumber: 12, removedLabel: REMOVED_SUBJECT_LABEL });
  });
});

describe("news created_at", () => {
  it.each([
    ["1731568000000", "2024-11-14T07:06:40.000Z"], // old Date.now() string, milliseconds
    ["1731568000", "2024-11-14T07:06:40.000Z"], // seconds
    [1731568000000, "2024-11-14T07:06:40.000Z"],
    ["2026-11-14T08:00:00.000Z", "2026-11-14T08:00:00.000Z"],
    ["2026-11-14", "2026-11-14T00:00:00.000Z"],
    ["not a date", null],
    ["", null],
    [null, null],
    [undefined, null],
  ])("%p -> %p", (input, expected) => {
    expect(normalizeCreatedAt(input)).toBe(expected);
  });

  it("getNews sends ISO created_at for every row", async () => {
    Event.findAll.mockResolvedValue([
      { toJSON: () => ({ eventId: 2, name: "PTA", created_at: "1731568000000" }) },
      { eventId: 1, name: "Sports", created_at: null },
    ]);
    expect(await getNews()).toEqual([
      { eventId: 2, name: "PTA", created_at: "2024-11-14T07:06:40.000Z" },
      { eventId: 1, name: "Sports", created_at: null },
    ]);
  });

  it("new events store an ISO timestamp, not Date.now()", async () => {
    Event.create.mockResolvedValue({});
    await createEvent({ name: "Open day" });
    const { created_at } = Event.create.mock.calls[0][0];
    expect(created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
