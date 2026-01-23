import { Event } from "../models/index.js";


const getNews = async () => {
    return await Event.findAll();
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