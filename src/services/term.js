import { Term } from "../models/index.js";

const getTerm = async () => {
    const response = await Term.findOne();
    return response;
}

export {
    getTerm,
}