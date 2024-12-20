import { Op } from "sequelize";
import Sequelize from "../config/database.js";
import { StudentMarks, StudentResult, Term } from "../models/index.js";
import { promoteStudents } from "./test.js";

const getTerm = async () => {
    const response = await Term.findOne({ 
        where: {
            active: true
        },
        raw: true
     });

    return response;
}

const getTerms = async () => {
    // const result = await updateDecember2024TermIds()
    // console.log("⭕result", result)
    const response = await Term.findAll({ raw: true });
    return response;
}

const setTerm = async (data) => {
    await Term.update({ active: false }, { where: {} });
    const response = await Term.create({
        term: data.term,
        startDate: data.startDate,
        endDate: data.endDate,
        autoCloseDate: data.autoCloseDate || null,
        active: true
    });

    return response;
}

const inactivateTerms = async (data) => {
    await promoteStudents()
    return await Term.update({ active: false }, { where: {} });
}


const editTerm = async (data, id) => {
    const response = await Term.update({
        term: data.term,
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

const updateDecember2024TermIds = async () => {
  try {
    const december2024Condition = {
        where: {
            date: {
              [Op.between]: [
                new Date('2024-12-01'),
                new Date('2024-12-31 23:59:59')
              ]
            }
          }
    };


    // Update StudentMarks
    const marksResult = await StudentMarks.update(
      { termId: 5 },
      december2024Condition
    );

    // Update StudentResult
    const resultsResult = await StudentResult.update(
      { termId: 5 },
      december2024Condition
    );
    // console.log("⭕resultsResult", resultsResult)
    return {
      marksUpdated: marksResult[0], // First element contains number of affected rows
      resultsUpdated: resultsResult[0]
    };
  } catch (error) {
    console.error('Error updating term_ids:', error);
    throw error;
  }
};

export {
    getTerm,
    setTerm,
    editTerm,
    inactivateTerms,
    getTerms
}