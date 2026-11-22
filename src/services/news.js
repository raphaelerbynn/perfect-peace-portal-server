import { Op } from "sequelize";
import { Event } from "../models/index.js";
import { AppError } from "../utils/errorHandling.js";
import { storage } from "./storage.js";
import { visibilityWhere } from "./posts.js";

// BE-D7: validation helpers for event/news create + edit. Reject bad input with
// a 400 (AppError) before touching the DB.
//
// `time` is a free-text VARCHAR in the DB; we accept common clock formats
// ("HH:mm" or "HH:mm:ss", optionally with an am/pm suffix) and otherwise reject.
const TIME_REGEX = /^([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?(\s?[AaPp][Mm])?$/;

const validateEventFields = (data, { partial = false } = {}) => {
    // name: required, non-empty string
    if (!partial || data?.name !== undefined) {
        if (typeof data?.name !== "string" || data.name.trim() === "") {
            throw new AppError("Event name is required.", 400);
        }
        if (data.name.trim().length > 150) {
            throw new AppError("The event name can be at most 150 characters.", 400);
        }
    }

    // date: must be a valid, parseable date when provided
    if (data?.date !== undefined && data?.date !== null && data?.date !== "") {
        const parsed = new Date(data.date);
        if (Number.isNaN(parsed.getTime())) {
            throw new AppError("A valid event date is required.", 400);
        }
    }

    // time: must match the expected clock format when provided
    if (data?.time !== undefined && data?.time !== null && data?.time !== "") {
        if (typeof data.time !== "string" || !TIME_REGEX.test(data.time.trim())) {
            throw new AppError("A valid event time is required (e.g. 14:30).", 400);
        }
    }
};

// BE-20: optional, backward-compatible pagination. No options => identical
// behaviour and shape (full array). limit/offset only applied when supplied.
//
// BE-21: both `/news` and `/events` map here (Event.findAll). In this system
// "news" and "events" are the SAME underlying concept - a single `Event` table
// backs both the parent-app news feed and the admin events list. There is no
// separate News model. The two route paths are kept as aliases for frontend
// compatibility (the portal app calls /news, the admin portal uses events).
//
// B15: the table now holds posts (news, events, polls). This list keeps its old
// shape for callers not yet moved to GET /posts. With a `viewer` (portal
// pupils/teachers) only PUBLISHED posts the viewer may see are listed (the
// audience filter); an Administrator gets every row, as before; other office
// roles get published posts (and a Class Teacher their own drafts). The image key and
// class ids never leave the server here.
const LEGACY_HIDDEN = ["imageKey", "audienceClassIds", "createdBy"];
const getNews = async (options = {}) => {
    const { page, limit, viewer } = options;

    // BE-D8: order newest-first. Order by the real `date` column (NOT the
    // `created_at` STRING column, which won't sort chronologically), tie-broken
    // by eventId so results are deterministic. Response shape and opt-in
    // pagination are unchanged.
    const queryOptions = {
        // B15: posts made on the new page often have no date: after the dated ones.
        order: [["date", "DESC NULLS LAST"], ["eventId", "DESC"]],
    };
    // Polls make no sense in the old list (no choices): left out for these callers.
    if (viewer) queryOptions.where = { [Op.and]: [...visibilityWhere(viewer, { publishedOnly: viewer.type !== "OFFICE" }), { postType: { [Op.ne]: "POLL" } }] };
    const parsedLimit = parseInt(limit, 10);
    const parsedPage = parseInt(page, 10);
    if (Number.isInteger(parsedLimit) && parsedLimit > 0) {
        queryOptions.limit = parsedLimit;
        const safePage = Number.isInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
        queryOptions.offset = (safePage - 1) * parsedLimit;
    }

    const rows = await Event.findAll(queryOptions);
    return rows.map((row) => {
        const plain = typeof row?.toJSON === "function" ? row.toJSON() : { ...row };
        plain.created_at = normalizeCreatedAt(plain.created_at);
        for (const k of LEGACY_HIDDEN) delete plain[k];
        if (viewer && viewer.type !== "OFFICE") delete plain.status;
        return plain;
    });
}

// `created_at` is a VARCHAR. The old code stored Date.now() as a string of
// milliseconds ("1731568000000"); new rows store an ISO timestamp. Send ISO
// either way, and null for anything unreadable.
export const normalizeCreatedAt = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const text = String(value).trim();
    const date = /^\d{10,13}$/.test(text)
        ? new Date(Number(text.length === 10 ? Number(text) * 1000 : text))
        : new Date(text);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const createEvent = async (data, createdBy = null) => {
    // BE-D7: validate before insert.
    validateEventFields(data);

    return await Event.create({
        name: data?.name,
        description: data?.description || null,
        date: data?.date || null,
        time: data?.time || null,
        created_at: new Date().toISOString(),
        // B15: an old-style add is a published news post for everyone.
        postType: "NEWS",
        status: "PUBLISHED",
        audience: "ALL",
        createdBy, // marks it as made in the new system (sync-data refuses then)
        publishedAt: new Date(),
        updatedAt: new Date(),
    });
}

const editEvent = async (data, eventId) => {
    // BE-D7: validate (partial - only enforce fields that are present), then
    // explicitly whitelist the updatable columns instead of spreading the whole
    // request body (prevents mass-assignment of eventId / created_at / etc.).
    validateEventFields(data, { partial: true });

    const allowed = {};
    if (data?.name !== undefined) allowed.name = data.name;
    if (data?.description !== undefined) allowed.description = data.description;
    if (data?.date !== undefined) allowed.date = data.date || null;
    if (data?.time !== undefined) allowed.time = data.time;
    allowed.updatedAt = new Date();
    // B15: a new start after the post's end date would break the 037 check:
    // the event then ends the day it starts.
    if (allowed.date) {
        const row = await Event.findByPk(eventId, { attributes: ["eventId", "eventEndDate"], raw: true });
        if (row?.eventEndDate && row.eventEndDate < allowed.date) allowed.eventEndDate = null;
    }

    return await Event.update(allowed, {
        where: {
            eventId: eventId
        }
    });
}

const removeEvent = async (eventId) => {
    // B15: likes, comments and votes go with the post (037); so does its image.
    const row = await Event.findByPk(eventId, { attributes: ["eventId", "imageKey"], raw: true });
    const out = await Event.destroy({
        where: {
            eventId: eventId
        }
    });
    if (row?.imageKey) await storage.remove(row.imageKey);
    return out;
}

export {
    getNews,
    createEvent,
    editEvent,
    removeEvent
}