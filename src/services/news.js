import { Event } from "../models/index.js";
import { AppError } from "../utils/errorHandling.js";

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
// "news" and "events" are the SAME underlying concept — a single `Event` table
// backs both the parent-app news feed and the admin events list. There is no
// separate News model. The two route paths are kept as aliases for frontend
// compatibility (the portal app calls /news, the admin portal uses events).
const getNews = async (options = {}) => {
    const { page, limit } = options;

    // BE-D8: order newest-first. Order by the real `date` column (NOT the
    // `created_at` STRING column, which won't sort chronologically), tie-broken
    // by eventId so results are deterministic. Response shape and opt-in
    // pagination are unchanged.
    const queryOptions = {
        order: [["date", "DESC"], ["eventId", "DESC"]],
    };
    const parsedLimit = parseInt(limit, 10);
    const parsedPage = parseInt(page, 10);
    if (Number.isInteger(parsedLimit) && parsedLimit > 0) {
        queryOptions.limit = parsedLimit;
        const safePage = Number.isInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
        queryOptions.offset = (safePage - 1) * parsedLimit;
    }

    return await Event.findAll(queryOptions);
}

const createEvent = async (data) => {
    // BE-D7: validate before insert.
    validateEventFields(data);

    return await Event.create({
        name: data?.name,
        description: data?.description || null,
        date: data?.date || null,
        time: data?.time || null,
        created_at: Date.now()
    });
}

const editEvent = async (data, eventId) => {
    // BE-D7: validate (partial — only enforce fields that are present), then
    // explicitly whitelist the updatable columns instead of spreading the whole
    // request body (prevents mass-assignment of eventId / created_at / etc.).
    validateEventFields(data, { partial: true });

    const allowed = {};
    if (data?.name !== undefined) allowed.name = data.name;
    if (data?.description !== undefined) allowed.description = data.description;
    if (data?.date !== undefined) allowed.date = data.date;
    if (data?.time !== undefined) allowed.time = data.time;

    return await Event.update(allowed, {
        where: {
            eventId: eventId
        }
    });
}

const removeEvent = async (eventId) => {
    return await Event.destroy({
        where: {
            eventId: eventId
        }
    });
}

export {
    getNews,
    createEvent,
    editEvent,
    removeEvent
}