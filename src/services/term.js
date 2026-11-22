import { Op } from "sequelize";
import sequelize from "../config/database.js";
import { Term } from "../models/index.js";
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

// A5a: "next term begins" is optional; when given it must be a real date after
// the term ends (it's printed on the report cards). Returns the value to store.
const validateNextTermBegins = ({ nextTermBegins, endDate }) => {
    if (nextTermBegins == null || nextTermBegins === "") return null;
    const next = String(nextTermBegins).slice(0, 10);
    const d = new Date(`${next}T00:00:00Z`);
    // Round-trip so impossible dates (2027-02-30 rolls over to 2 March) are refused, not a Postgres 500.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(next) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== next) {
        throw new AppError("nextTermBegins must be a valid date", 400);
    }
    if (endDate && next <= String(endDate).slice(0, 10)) {
        throw new AppError("Next term must begin after this term ends", 400);
    }
    return next;
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

// For new features: the active term, or a clear 409 when the school has not
// opened one yet (instead of each caller null-checking getTerm()).
const requireActiveTerm = async ({ transaction = null } = {}) => {
    const term = await Term.findOne({ where: { active: true }, raw: true, transaction });
    if (!term) {
        throw new AppError("No term is open. Open a term in Settings first.", 409);
    }
    return term;
}

const getTerms = async () => {
    const response = await Term.findAll({ raw: true });
    return response;
}

const setTerm = async (data) => {
    // BE-D5: validate dates / overlap BEFORE mutating anything.
    await validateTermDates(data);
    const nextTermBegins = validateNextTermBegins(data);

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
                // NO scheduler that auto-promotes/closes on this date - auto-promoting
                // students unattended is too risky. Term closing is MANUAL via
                // POST /close-term (see inactivateTerms below). We still persist the
                // value so the UI can display/remind on it.
                autoCloseDate: data.autoCloseDate || null,
                nextTermBegins,
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
// BE-D14: this is the ONLY way a term is closed - it is a deliberate, MANUAL,
// admin-triggered action (POST /close-term). It is never run automatically off
// `autoCloseDate`.
const inactivateTerms = async (data) => {
    await sequelize.transaction(async (t) => {
        // Claim the open term first (row lock): a second "Close term" at the
        // same moment waits here, then finds no open term (409) instead of
        // promoting, and billing, everyone a second time.
        const term = await Term.findOne({
            where: { active: true },
            raw: true,
            transaction: t,
            ...(t?.LOCK ? { lock: t.LOCK.UPDATE } : {}),
        });
        if (!term) throw new AppError("No term is open", 409);
        await promoteStudents(t, term);
        await Term.update({ active: false }, { where: {}, transaction: t });
    });
    return { message: "Term closed and students promoted successfully" };
}


const editTerm = async (data, id) => {
    // BE-D5: validate the edited window and ensure it doesn't overlap OTHER terms.
    await validateTermDates(data, id);
    const nextTermBegins = validateNextTermBegins(data);

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
            // BE-D14: see note in setTerm - informational only.
            autoCloseDate: data.autoCloseDate || null,
        };
        // Only change it when the request carries the field (older clients don't send it).
        if (Object.prototype.hasOwnProperty.call(data, "nextTermBegins")) {
            updatePayload.nextTermBegins = nextTermBegins;
        }
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

export {
    validateNextTermBegins,
    requireActiveTerm,
    getTerm,
    setTerm,
    editTerm,
    inactivateTerms,
    getTerms
}