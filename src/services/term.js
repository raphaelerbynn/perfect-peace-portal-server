import { Op } from "sequelize";
import sequelize from "../config/database.js";
import { KgAssessment, KgCalcValues, StudentMarks, StudentResult, Term } from "../models/index.js";
import { promoteStudents } from "./test.js";
import { AppError } from "../utils/errorHandling.js";

// BE-D5: validate a term's date window and that it does not collide with any
// existing term. Throws AppError(400) on violation so the controller's
// next(error) surfaces a clean 400 to the client.
//   - startDate / endDate must both be present and start <= end.
//   - the [startDate, endDate] range must NOT overlap any other term's range.
// `excludeTermId` lets editTerm ignore the row being edited.
const validateTermDates = async ({ startDate, endDate }, excludeTermId = null, transaction = null) => {
    if (!startDate || !endDate) {
        throw new AppError("startDate and endDate are required", 400);
    }

    const start = new Date(startDate);
    const end = new Date(endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        throw new AppError("startDate and endDate must be valid dates", 400);
    }
    if (start > end) {
        throw new AppError("startDate must be on or before endDate", 400);
    }

    // Two ranges overlap when each starts on/before the other ends:
    //   existing.start <= new.end AND existing.end >= new.start
    const where = {
        startDate: { [Op.lte]: endDate },
        endDate: { [Op.gte]: startDate },
    };
    if (excludeTermId != null) {
        where.termId = { [Op.ne]: excludeTermId };
    }

    const overlapping = await Term.findOne({ where, raw: true, transaction });
    if (overlapping) {
        throw new AppError(
            `Term dates overlap an existing term (${overlapping.term || `#${overlapping.termId}`})`,
            400
        );
    }
};

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
    // BE-D5: validate dates / overlap BEFORE mutating anything.
    await validateTermDates(data);

    // BE-D5: deactivate-then-create must be atomic. Previously a failed create
    // left ZERO active terms (the update had already committed), which breaks
    // every `where: { active: true }` read. Wrap both in one transaction so a
    // failure rolls the deactivation back too.
    return await sequelize.transaction(async (t) => {
        await Term.update({ active: false }, { where: {}, transaction: t });
        const response = await Term.create(
            {
                term: data.term,
                startDate: data.startDate,
                endDate: data.endDate,
                // BE-D14: autoCloseDate is INFORMATIONAL ONLY. There is deliberately
                // NO scheduler that auto-promotes/closes on this date — auto-promoting
                // students unattended is too risky. Term closing is MANUAL via
                // POST /close-term (see inactivateTerms below). We still persist the
                // value so the UI can display/remind on it.
                autoCloseDate: data.autoCloseDate || null,
                active: true,
            },
            { transaction: t }
        );

        return response;
    });
}

// BE-D4: closing a term promotes every eligible student AND deactivates the
// term. These two steps must be all-or-nothing: if promotion fails partway,
// the term must NOT be left deactivated (and vice versa). We run both inside a
// single transaction and let errors propagate (no swallowing) so the controller
// forwards them to the error handler.
//
// BE-D14: this is the ONLY way a term is closed — it is a deliberate, MANUAL,
// admin-triggered action (POST /close-term). It is never run automatically off
// `autoCloseDate`.
const inactivateTerms = async (data) => {
    await sequelize.transaction(async (t) => {
        await promoteStudents(t);
        await Term.update({ active: false }, { where: {}, transaction: t });
    });
    return { message: "Term closed and students promoted successfully" };
}


const editTerm = async (data, id) => {
    // BE-D5: validate the edited window and ensure it doesn't overlap OTHER terms.
    await validateTermDates(data, id);

    return await sequelize.transaction(async (t) => {
        const existing = await Term.findOne({ where: { termId: id }, transaction: t });
        if (!existing) {
            throw new AppError("Term not found", 400);
        }

        // BE-D5: editTerm must not silently create a second active term out of
        // band. If the caller tries to activate this term, deactivate all others
        // first (mirrors setTerm) so exactly one active term remains.
        const wantsActive = data.active === true || data.active === "true" || data.active === 1 || data.active === "1";
        if (wantsActive && !existing.active) {
            await Term.update({ active: false }, { where: {}, transaction: t });
        }

        const updatePayload = {
            term: data.term,
            startDate: data.startDate,
            endDate: data.endDate,
            // BE-D14: see note in setTerm — informational only.
            autoCloseDate: data.autoCloseDate || null,
        };
        if (wantsActive) {
            updatePayload.active = true;
        }

        const response = await Term.update(updatePayload, {
            where: { termId: id },
            transaction: t,
        });
        return response;
    });
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
    const marksResult = await KgAssessment.update(
      { termId: 5 },
      december2024Condition
    );

    // Update StudentResult
    // const resultsResult = await KgCalcValues.update(
    //   { termId: 5 },
    //   december2024Condition
    // );
    // console.log("⭕resultsResult", resultsResult)
    return {
      marksUpdated: marksResult[0] // First element contains number of affected rows
    //   resultsUpdated: resultsResult[0]
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