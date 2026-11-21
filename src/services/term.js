import { Op } from "sequelize";
import sequelize from "../config/database.js";
import { AcademicYear, Term } from "../models/index.js";
import { AppError } from "../utils/errorHandling.js";
import { getStatus } from "./promotion.js";
import { assertTermFitsYear, resolveTermYear, setCurrentYear, termName } from "./academicYear.js";

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

// B7: each term carries its year's name, for "Term 2 · 2026/2027" pickers.
const withYearNames = async (terms) => {
    const ids = [...new Set(terms.map((t) => t.academicYearId).filter((id) => id != null))];
    const years = ids.length
        ? await AcademicYear.findAll({ where: { academicYearId: ids }, attributes: ["academicYearId", "name", "isCurrent", "status"], raw: true })
        : [];
    const byId = new Map(years.map((y) => [y.academicYearId, y]));
    return terms.map((t) => {
        const y = t.academicYearId != null ? byId.get(t.academicYearId) : null;
        return { ...t, academicYearName: y?.name ?? null, academicYearIsCurrent: Boolean(y?.isCurrent) };
    });
};

const getTerms = async () => {
    const response = await Term.findAll({ raw: true });
    return withYearNames(response);
}

// The open term for the dashboard badge / term settings, with its year's name.
const getActiveTermDetails = async () => {
    const term = await getTerm();
    if (!term) return term;
    return (await withYearNames([term]))[0];
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
        // B7: a new term belongs to an academic year (the one chosen, or the
        // year its start date falls in) and must fit inside it.
        const year = await resolveTermYear(data, { transaction: t });
        await assertTermFitsYear(year, data, null, { transaction: t });
        await Term.update({ active: false }, { where: {}, transaction: t });
        const response = await Term.create(
            {
                academicYearId: year.academicYearId,
                term: data.term,
                startDate: data.startDate,
                endDate: data.endDate,
                // BE-D14: autoCloseDate is INFORMATIONAL ONLY. There is deliberately
                // NO scheduler that auto-promotes/closes on this date — auto-promoting
                // students unattended is too risky. Term closing is MANUAL via
                // POST /close-term (see inactivateTerms below). We still persist the
                // value so the UI can display/remind on it.
                autoCloseDate: data.autoCloseDate || null,
                nextTermBegins,
                active: true,
            },
            { transaction: t }
        );
        // Opening a term makes its year the current one.
        await setCurrentYear(year.academicYearId, { transaction: t });

        return response;
    });
}

// BE-D14: this is the ONLY way a term is closed — it is a deliberate, MANUAL,
// admin-triggered action (POST /close-term). It is never run automatically off
// `autoCloseDate`.
//
// B5: closing no longer moves pupils. Promotion is its own step (preview →
// accept, services/promotion.js), done before or after closing term 3. The
// response says how many classes still have pupils without a decision.
const inactivateTerms = async (data) => {
    const term = await Term.findOne({ where: { active: true }, raw: true });
    if (!term) throw new AppError("No term is open", 409);
    await Term.update({ active: false }, { where: {} });
    let pendingClasses = 0;
    if (String(term.term) === "3") {
        // The term is already closed here: a failed count must not turn the
        // response into an error (a retry would then say "No term is open").
        try {
            pendingClasses = (await getStatus({ termId: term.termId })).pendingClasses;
        } catch (e) {
            console.error("close-term: couldn't count classes still to promote", e);
        }
    }
    return {
        message: pendingClasses
            ? `Term closed. ${pendingClasses} class${pendingClasses === 1 ? " still needs" : "es still need"} promotion: open Promotion to move pupils up.`
            : "Term closed",
        termId: term.termId,
        pendingClasses,
    };
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
        // B7: keep the term inside its year (the one sent, the one it is in,
        // or the year its dates fall in; an old term with no year stays so).
        const year = await resolveTermYear(
            { academicYearId: data.academicYearId ?? existing.academicYearId, startDate: data.startDate },
            { transaction: t, required: data.academicYearId != null && data.academicYearId !== "" }
        );
        if (year) await assertTermFitsYear(year, data, existing.termId ?? id, { transaction: t });

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
        // Only change it when the request carries the field (older clients don't send it).
        if (Object.prototype.hasOwnProperty.call(data, "nextTermBegins")) {
            updatePayload.nextTermBegins = nextTermBegins;
        }
        if (year) updatePayload.academicYearId = year.academicYearId;
        if (wantsActive) {
            updatePayload.active = true;
        }

        const response = await Term.update(updatePayload, {
            where: { termId: id },
            transaction: t,
        });
        if (year && (wantsActive || existing.active)) await setCurrentYear(year.academicYearId, { transaction: t });
        return response;
    });
}

// --- B7: terms managed from Academic years ---------------------------------

// Adds a term to a year WITHOUT opening it (open it later with activateTerm).
const createYearTerm = async (academicYearId, data = {}) => {
    if (!["1", "2", "3"].includes(String(data.term ?? "").trim())) {
        throw new AppError("Choose Term 1, 2 or 3", 400);
    }
    await validateTermDates(data);
    const nextTermBegins = validateNextTermBegins(data);
    return sequelize.transaction(async (t) => {
        const year = await resolveTermYear({ academicYearId }, { transaction: t });
        await assertTermFitsYear(year, data, null, { transaction: t });
        const row = await Term.create(
            {
                academicYearId: year.academicYearId,
                term: String(data.term).trim(),
                startDate: data.startDate,
                endDate: data.endDate,
                autoCloseDate: data.autoCloseDate || null,
                nextTermBegins,
                active: false,
            },
            { transaction: t }
        );
        return typeof row?.toJSON === "function" ? row.toJSON() : row;
    });
};

// Opens a term: only when no other term is open (close it first, so its
// attendance is rolled up). The term's year becomes the current year.
const assertTermId = (id) => {
    if (!/^\d+$/.test(String(id ?? ""))) throw new AppError("Term not found", 404);
};

const activateTerm = async (id) =>
    assertTermId(id) ?? sequelize.transaction(async (t) => {
        const term = await Term.findOne({ where: { termId: id }, raw: true, transaction: t, lock: t.LOCK?.UPDATE });
        if (!term) throw new AppError("Term not found", 404);
        if (term.active) return { ...term, alreadyOpen: true };
        if (term.academicYearId == null) {
            throw new AppError("Put this term in an academic year first (edit its dates)", 400);
        }
        const open = await Term.findOne({ where: { active: true }, raw: true, transaction: t });
        if (open) {
            throw new AppError(`${termName(open)} is still open. Close it first (Term details → Close / end term).`, 409);
        }
        await Term.update({ active: true }, { where: { termId: term.termId }, transaction: t });
        await setCurrentYear(term.academicYearId, { transaction: t });
        return { ...term, active: true };
    });

// What still points at a term (a term with any of these can't be deleted).
// Postgres: one round trip, each count a subquery.
export const TERM_REFERENCES = [
    ["payment", `SELECT COUNT(*) FROM "dbo"."Fee" WHERE term_id = :id`],
    ["register entry", `SELECT COUNT(*) FROM "dbo"."Attendance" WHERE term_id = :id`],
    ["attendance total", `SELECT COUNT(*) FROM "dbo"."Total_attendance" WHERE term_id = :id`],
    ["mark", `SELECT COUNT(*) FROM "dbo"."Student_marks" WHERE term_id = :id`],
    ["result", `SELECT COUNT(*) FROM "dbo"."Student_result" WHERE term_id = :id`],
    ["KG assessment", `SELECT COUNT(*) FROM "dbo"."KG_assessment" WHERE term_id = :id`],
    ["teaching assignment", `SELECT COUNT(*) FROM "dbo"."Teaching_assignment" WHERE term_id = :id`],
    ["timetable lesson", `SELECT COUNT(*) FROM "dbo"."Timetable_entry" WHERE term_id = :id`],
    ["promotion decision", `SELECT COUNT(*) FROM "dbo"."Student_promotion" WHERE term_id = :id`],
    ["salary payment", `SELECT COUNT(*) FROM "dbo"."Salary_payment" WHERE term = :id`],
    // B12
    ["term bill", `SELECT COUNT(*) FROM "dbo"."Student_term_bill" WHERE term_id = :id`],
    ["pupil fee period", `SELECT COUNT(*) FROM "dbo"."Student" WHERE fees_period_term_id = :id`],
    ["pupil discount", `SELECT COUNT(*) FROM "dbo"."Student_discount" WHERE from_term_id = :id OR to_term_id = :id`],
    // B14
    ["invoice", `SELECT COUNT(*) FROM "dbo"."Invoice" WHERE term_id = :id`],
    ["credit note", `SELECT COUNT(*) FROM "dbo"."Credit_note" WHERE term_id = :id`],
];

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Pure: "Term 1 can't be deleted: it still has 3 marks, 1 payment. ..." or null. */
export const referenceMessage = (name, counts) => {
    const used = Object.entries(counts).filter(([, n]) => Number(n) > 0);
    if (!used.length) return null;
    return `${name} can't be deleted: it still has ${used.map(([w, n]) => plural(Number(n), w)).join(", ")}.`;
};

const deleteTerm = async (id) =>
    assertTermId(id) ?? sequelize.transaction(async (t) => {
        const term = await Term.findOne({ where: { termId: id }, raw: true, transaction: t, lock: t.LOCK?.UPDATE });
        if (!term) throw new AppError("Term not found", 404);
        if (term.active) throw new AppError(`${termName(term)} is open. Close it before deleting it.`, 409);
        const sql = `SELECT ${TERM_REFERENCES.map(([, q], i) => `(${q}) AS "c${i}"`).join(", ")}`;
        const [[row]] = await sequelize.query(sql, { replacements: { id: term.termId }, transaction: t });
        const counts = Object.fromEntries(TERM_REFERENCES.map(([w], i) => [w, Number(row?.[`c${i}`]) || 0]));
        const message = referenceMessage(termName(term), counts);
        if (message) {
            const err = new AppError(message, 409);
            err.counts = counts;
            throw err;
        }
        await Term.destroy({ where: { termId: term.termId }, transaction: t });
        return { deleted: true, termId: term.termId };
    });

export {
    getActiveTermDetails,
    createYearTerm,
    activateTerm,
    deleteTerm,
    validateNextTermBegins,
    requireActiveTerm,
    getTerm,
    setTerm,
    editTerm,
    inactivateTerms,
    getTerms
}