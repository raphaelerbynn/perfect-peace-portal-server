import { Event } from "../models/index.js";


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

    const queryOptions = {};
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
    return await Event.create({
        name: data?.name,
        description: data?.description || null,
        date: data?.date || null,
        time: data?.time || null,
        created_at: Date.now()
    });
}

const editEvent = async (data, eventId) => {
    return await Event.update(data, {
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