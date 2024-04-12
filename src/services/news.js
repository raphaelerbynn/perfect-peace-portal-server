import { Event } from "../models/index.js";


const getNews = async () => {
    return await Event.findAll();
}


export {
    getNews
}