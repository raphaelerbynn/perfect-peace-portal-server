import { Term } from "../models/index.js";

const getTerm = async () => {
    const response = await Term.findOne({ 
        where: {
            active: true
        },
        raw: true
     });

    return response;
}

const setTerm = async (data) => {
    await Term.update({ active: false }, { where: {} });
    const response = await Term.create({
        startDate: data.startDate,
        endDate: data.endDate,
        autoCloseDate: data.autoCloseDate || null,
        active: true
    });

    return response;
}

const inactivateTerms = async (data) => {
    return await Term.update({ active: false }, { where: {} });
}


const editTerm = async (data, id) => {
    const response = await Term.update({
        startDate: data.startDate,
        endDate: data.endDate,
        autoCloseDate: data.autoCloseDate || null,
    }, {
        where: {
            termId: id
        }
    });
    return response;
}


export {
    getTerm,
    setTerm,
    editTerm,
    inactivateTerms
}