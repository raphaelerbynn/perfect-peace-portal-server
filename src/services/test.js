import { Class, ClassFee, KgAssessment, Parent, Student, StudentResult, StudentFee, Teacher } from "../models/index.js";
import { Op } from "sequelize";
import sequelize from "../config/database.js";
import { isValidPhoneNumber, calculateAge } from "../utils/func.js";
import { AppError } from "../utils/errorHandling.js";
import { getTerm } from "./term.js";
// BE-D4: getClassIdByName was previously USED here but never imported, so the
// original per-student promotion threw a (swallowed) ReferenceError and likely
// never promoted anyone. Import it properly now that errors propagate.
import { getClassIdByName } from "./classes.js";
import { recomputeStudentOwing } from "./fee.js";

// BE-20: optional, backward-compatible pagination + lazy-loading.
// Calling `getStudents()` with no options returns EXACTLY what it returned
// before (full array, all nested associations, same shape). Pagination and the
// lighter include set only kick in when the caller opts in via query params.
export const getStudents = async (options = {}) => {
    // BE-D6: do NOT swallow DB errors. Previously a `catch (e) { console.log }`
    // returned undefined, so the controller sent HTTP 200 with an empty body on
    // failure. Let the error propagate so the controller forwards it to the
    // central errorHandler (proper 500).
    //
    // BE-S4: server-side search / filter / pagination + Class-Teacher scoping,
    // and ALWAYS exclude soft-deleted (is_deleted) rows. Dialect is MySQL, so
    // LIKE is already case-insensitive under the default (ci) collation, but we
    // also lower-case tokens defensively. Age filtering is pushed into the SQL
    // WHERE via a dob window so pagination/count stay correct.
    const {
        page,
        limit,
        lite,
        search,
        gender,
        minAge,
        maxAge,
        requester,
    } = options;
    let { classId, className } = options;

    // --- Class-Teacher scoping (authoritative, server-side) ---------------
    // A Class Teacher may ONLY ever see their own class. We resolve their
    // classId from the Teacher row and FORCE it, ignoring any client-supplied
    // classId/className. If they have no class assigned, return empty (no throw).
    let scopedToEmpty = false;
    if (requester?.role === "Class Teacher") {
        const teacher = await Teacher.findOne({
            where: { teacherId: requester.teacherId },
            attributes: ["classId"],
            raw: true,
        });
        if (teacher?.classId == null) {
            scopedToEmpty = true;
        } else {
            classId = teacher.classId;
            className = undefined; // classId takes precedence
        }
    }

    // --- Build WHERE -------------------------------------------------------
    const where = {
        // ALWAYS exclude soft-deleted rows.
        isDeleted: { [Op.not]: true },
    };

    // search: trim + collapse whitespace, split into tokens. Each token must
    // match (Op.or) one of fName/mName/lName via LIKE %token%; all tokens are
    // AND-ed together so "ama men" matches "Ama ... Mensah".
    if (typeof search === "string") {
        const cleaned = search.trim().replace(/\s+/g, " ");
        if (cleaned.length > 0) {
            const tokens = cleaned.split(" ");
            where[Op.and] = tokens.map((token) => {
                const like = { [Op.like]: `%${token.toLowerCase()}%` };
                return {
                    [Op.or]: [
                        { fName: like },
                        { mName: like },
                        { lName: like },
                    ],
                };
            });
        }
    }

    // gender: case-insensitive exact (MySQL ci collation handles this).
    if (typeof gender === "string" && gender.trim().length > 0) {
        where.gender = gender.trim();
    }

    // class filter (overridden / forced by scoping above when Class Teacher).
    if (classId != null && `${classId}`.length > 0) {
        where.classId = classId;
    } else if (typeof className === "string" && className.trim().length > 0) {
        where.class = className.trim();
    }

    // age -> dob window (pushed into SQL WHERE; never post-fetch).
    // A student is `age` years old when born between
    //   (today - (age+1) years + 1 day)  ..  (today - age years)
    // So:  minAge => dob <= today - minAge years          (born early enough)
    //      maxAge => dob >  today - (maxAge+1) years       (not too old)
    const parsedMinAge = Number.parseInt(minAge, 10);
    const parsedMaxAge = Number.parseInt(maxAge, 10);
    const hasMin = Number.isInteger(parsedMinAge) && parsedMinAge >= 0;
    const hasMax = Number.isInteger(parsedMaxAge) && parsedMaxAge >= 0;
    if (hasMin || hasMax) {
        const toIso = (d) => d.toISOString().slice(0, 10);
        const dobWhere = {};
        if (hasMin) {
            const upper = new Date();
            upper.setFullYear(upper.getFullYear() - parsedMinAge);
            dobWhere[Op.lte] = toIso(upper);
        }
        if (hasMax) {
            // exclusive lower bound: born AFTER (today - (maxAge+1) years)
            const lower = new Date();
            lower.setFullYear(lower.getFullYear() - (parsedMaxAge + 1));
            lower.setDate(lower.getDate() + 1);
            dobWhere[Op.gte] = toIso(lower);
        }
        where.dob = dobWhere;
    }

    // Heaviest nested associations (Class -> ClassFee, StudentFee) are only
    // dropped when the caller explicitly opts in with `lite`. Default keeps
    // the full include tree so existing consumers are unaffected.
    const liteRequested = lite === true || lite === "true" || lite === "1";
    const include = liteRequested
        ? [
            {
                model: Parent,
                as: "parent",
            },
        ]
        : [
            {
                model: Parent,
                as: "parent",
            },
            {
                model: Class,
                as: "class_",
                include: [
                    {
                    model: ClassFee,
                    as: "classFee",
                    },
                ],
            },
            {
                model: StudentFee,
                as: "studentFee",
            }
        ];

    const queryOptions = {
        attributes: { exclude: ['password'] },
        where,
        include,
        raw: true,
    };

    // Pagination is opt-in: only when page OR limit is supplied.
    const parsedLimit = parseInt(limit, 10);
    const parsedPage = parseInt(page, 10);
    const hasLimit = Number.isInteger(parsedLimit) && parsedLimit > 0;
    const hasPage = Number.isInteger(parsedPage) && parsedPage > 0;
    const paginate = page != null || limit != null;

    const effectiveLimit = hasLimit ? parsedLimit : 20; // default page size
    const effectivePage = hasPage ? parsedPage : 1;

    if (paginate) {
        queryOptions.limit = effectiveLimit;
        queryOptions.offset = (effectivePage - 1) * effectiveLimit;
        // `subQuery: false` keeps limit/offset on the top-level Student query
        // when hasMany associations are included, so the count is correct.
        queryOptions.subQuery = false;
    }

    const addAge = (rows) => {
        // calculate age for each student (real date diff — BE-25)
        rows.forEach((student) => {
            student.age = calculateAge(student?.dob);
        });
        return rows;
    };

    // Class-Teacher with no class => empty result, in the caller's shape.
    if (scopedToEmpty) {
        if (paginate) {
            return {
                students: [],
                total: 0,
                page: effectivePage,
                limit: effectiveLimit,
                totalPages: 0,
            };
        }
        return [];
    }

    if (paginate) {
        // findAndCountAll with distinct student_id so hasMany includes don't
        // inflate the total. subQuery:false keeps LIMIT on the parent query.
        const { rows, count } = await Student.findAndCountAll({
            ...queryOptions,
            distinct: true,
            col: "student_id",
        });
        const total = typeof count === "number" ? count : (Array.isArray(count) ? count.length : 0);
        return {
            students: addAge(rows),
            total,
            page: effectivePage,
            limit: effectiveLimit,
            totalPages: Math.ceil(total / effectiveLimit),
        };
    }

    const students = await Student.findAll(queryOptions);
    return addAge(students);
};

export const getParentContact = async (id, forAttendance=false, status="") => {
    // BE-S4: do NOT swallow errors generally, but this runs inside an attendance
    // Promise.all loop — a single student with a missing/invalid parent contact
    // must NOT abort the whole batch. So we guard nulls and console.warn instead
    // of throwing, and exclude archived students.
    const student = await Student.findOne({
        attributes: ["fName", "mName", "lName"],
        where: {
            studentId: id,
            isDeleted: { [Op.not]: true },
        },
        include: [
            {
                model: Parent,
                as: "parent",
            }
        ],
    });

    const childName = student
        ? [student.fName, student.mName, student.lName].filter(Boolean).join(" ")
        : "";

    const contacts = [];
    if (student?.parent) {
        const { contact, contact1 } = student.parent;
        if (isValidPhoneNumber(contact)) {
            contacts.push(contact);
        }
        if (isValidPhoneNumber(contact1)) {
            contacts.push(contact1);
        }
    }

    if (contacts.length === 0) {
        // Surface failed/blocked SMS so attendance notifications are debuggable,
        // without aborting the surrounding Promise.all.
        console.warn(`No valid parent contact for student ${id} (${childName || "unknown"})`);
    }

    return forAttendance
        ? { childName, contact: contacts?.[0], status: status?.toLowerCase?.() ?? status }
        : contacts;
}

// BE-D4: promote every eligible student for the active term. Runs as part of
// the atomic close-term transaction — accepts an optional `transaction` and
// threads it through every read/write so a failure rolls the whole close back.
//
// Errors are NO LONGER swallowed: previously per-student failures were logged
// and the outer catch returned undefined, so closeTerm reported success even
// when nothing (or only some students) were promoted, leaving inconsistent
// state. We now let any failure propagate so the surrounding transaction aborts
// and the controller's next(error) fires.
export const promoteStudents = async (transaction = null) => {
    const term = await getTerm()
    if (!term) {
        throw new Error("No active term found; cannot promote students");
    }

    // --- Basic class students (StudentResult) ---
    const allPromotedStudents = await StudentResult.findAll({
        attributes: ["studentId", "promotedTo"],
        where: {
            termId: term.termId,
            term: "3"
        },
        raw: true,
        transaction
    })

    let basicPromoted = 0;
    for (const student of allPromotedStudents) {
        if (!student.promotedTo) continue; // skip students without a promotedTo value
        const newClassId = await getClassIdByName(student.promotedTo, transaction);
        if (newClassId == null) {
            console.warn(`⚠️ Class "${student.promotedTo}" not found for student ${student.studentId}, skipping`);
            continue;
        }
        await Student.update(
            { classId: newClassId, class: student.promotedTo },
            { where: { studentId: student.studentId }, transaction }
        );
        basicPromoted += 1;
    }
    console.log(`🥳 Promoted ${basicPromoted} basic-class students`)

    // --- KG / Nursery students (KgAssessment) ---
    const allPromotedKgStudents = await KgAssessment.findAll({
        attributes: ["studentId", "promoted"],
        where: {
            termId: term.termId,
            term: "3",
            category: "Language Development (Reading, Listening and Oral Skills)"
        },
        raw: true,
        transaction
    })

    let kgPromoted = 0;
    for (const student of allPromotedKgStudents) {
        if (!student.promoted) continue; // skip students without a promoted value
        const newClassId = await getClassIdByName(student.promoted, transaction);
        if (newClassId == null) {
            console.warn(`⚠️ Class "${student.promoted}" not found for KG student ${student.studentId}, skipping`);
            continue;
        }
        await Student.update(
            { classId: newClassId, class: student.promoted },
            { where: { studentId: student.studentId }, transaction }
        );
        kgPromoted += 1;
    }
    console.log(`🥳 Promoted ${kgPromoted} KG students`)
}

export const createStudent = async (data) => {
    // BE-S4: validate-then-write inside ONE transaction. Errors propagate as
    // AppError so the central errorHandler maps clean status codes (no SQL leak).
    return await sequelize.transaction(async (t) => {
        // --- Validation (AppError 400 on failure) -------------------------
        const fName = data?.fName?.trim?.();
        const lName = data?.lName?.trim?.();
        if (!fName) throw new AppError("First name is required", 400);
        if (!lName) throw new AppError("Last name is required", 400);

        if (!data?.dob) throw new AppError("Date of birth is required", 400);
        const dobDate = new Date(data.dob);
        if (isNaN(dobDate.getTime()) || dobDate > new Date()) {
            throw new AppError("Date of birth is invalid", 400);
        }
        const age = calculateAge(data.dob);
        if (age == null || age < 1 || age > 25) {
            throw new AppError("Date of birth is out of the allowed range", 400);
        }

        if (!data?.gender || `${data.gender}`.trim().length === 0) {
            throw new AppError("Gender is required", 400);
        }

        // class must resolve to a real classId.
        if (!data?.class || `${data.class}`.trim().length === 0) {
            throw new AppError("Class is required", 400);
        }
        const _class = await Class.findOne({
            attributes: ["classId"],
            where: { name: data.class },
            raw: true,
            transaction: t,
        });
        const resolvedClassId = _class?.classId ?? _class?.class_id;
        if (resolvedClassId == null) {
            throw new AppError(`Class "${data.class}" does not exist`, 400);
        }

        // parent contact (if supplied) must be a valid phone number.
        if (data?.contact != null && `${data.contact}`.trim().length > 0) {
            if (!isValidPhoneNumber(data.contact)) {
                throw new AppError("Parent contact is not a valid phone number", 400);
            }
        }
        if (data?.contact1 != null && `${data.contact1}`.trim().length > 0) {
            if (!isValidPhoneNumber(data.contact1)) {
                throw new AppError("Parent secondary contact is not a valid phone number", 400);
            }
        }

        // --- Duplicate check (non-deleted same fName+lName+dob) -----------
        const duplicate = await Student.findOne({
            where: {
                fName,
                lName,
                dob: data.dob,
                isDeleted: { [Op.not]: true },
            },
            attributes: ["studentId"],
            raw: true,
            transaction: t,
        });
        if (duplicate) {
            throw new AppError("A student with the same name and date of birth already exists", 409);
        }

        // --- Create Parent FIRST, read its PK from the create result ------
        const parent = await Parent.create(
            {
                fName: data.pfName,
                lName: data.plName,
                gender: data.pGender,
                contact: data.contact,
                contact1: data.contact1,
                relationship: data.relationship,
                occupation: data.occupation,
            },
            { transaction: t }
        );
        const parentId = parent.dataValues.parent_id ?? parent.dataValues.parentId;

        // --- Create Student with parentId set directly --------------------
        const newStudent = await Student.create(
            {
                fName,
                mName: data.mName,
                lName,
                dob: data.dob,
                gender: data.gender,
                class: data.class,
                classId: resolvedClassId,
                parentId,
                feesPaid: 0,
                address: data.address,
                dateRegistered: new Date(),
                isDeleted: false,
            },
            { transaction: t }
        );

        const newStudentId = newStudent.dataValues.student_id ?? newStudent.dataValues.studentId;

        // Reconcile cached fees columns from the underlying rows.
        await recomputeStudentOwing(newStudentId, { transaction: t });

        return newStudent;
    });
}

export const editStudent = async (data, id) => {
        const _class = await Class.findAll({
            attributes: ["class_id", "fees"],
            where: {
                name: data.class
            }
        });

        const currentStudent = await Student.findOne({
            where: { studentId: id }
        });

        // BE-S13: verify the row exists; a missing student previously no-oped to a
        // silent HTTP 200. Errors now propagate to the central errorHandler.
        if (!currentStudent) {
            throw new AppError("Student not found", 404);
        }

        const parent_id = currentStudent?.parentId || currentStudent?.parent_id;

        const newClassId = _class[0]?.dataValues?.classId ?? _class[0]?.dataValues?.class_id;
        const classChanged = currentStudent && newClassId != null && Number(currentStudent.classId) !== Number(newClassId);

        // Build update payload — only touch fees when class actually changes.
        const studentUpdate = {
            fName: data.fName,
            mName: data.mName,
            lName: data.lName,
            dob: data.dob,
            gender: data.gender,
            class: data.class,
            address: data.address,
            classId: newClassId,
            dateUpdated: new Date()
        };

        // BE-D3: run the student + parent writes (and the class-change owing
        // reconcile) in ONE transaction instead of Promise.allSettled, which
        // silently ignored a failed half. The Student row (incl. new classId)
        // must be persisted BEFORE recomputeStudentOwing reads it.
        const response = await sequelize.transaction(async (t) => {
            const studentRes = await Student.update(studentUpdate, {
                where: { studentId: id },
                transaction: t,
            });

            const parentRes = await Parent.update(
                {
                    fName: data.pfName,
                    lName: data.plName,
                    gender: data.pGender,
                    contact: data.contact,
                    contact1: data.contact1,
                    relationship: data.relationship,
                    occupation: data.occupation,
                },
                {
                    where: { parent_id: parent_id },
                    transaction: t,
                }
            );

            if (classChanged) {
                // BE-D3: reconcile feesOwing/feesPaid from the underlying rows for
                // the NEW class. recomputeStudentOwing derives:
                //   feesOwing = (new ClassFee total + StudentFee total) - sum(Fee.paid)
                //   feesPaid  = sum(Fee.paid)
                //
                // NOTE / FLAGGED FOR FEES REVIEW: this DELIBERATELY DIFFERS from the
                // prior inline behaviour, which on class change reset feesPaid to 0
                // and feesOwing to the full new bill (i.e. wiped the student's
                // payment history). The helper instead keeps real payments (Fee
                // rows are not deleted on class change) and credits them against the
                // new bill. This is the more defensible accounting behaviour and is
                // now consistent with every other fee path, but if the school truly
                // intends "class change = blank slate, ignore prior payments", revert
                // THIS call to the explicit feesPaid=0 / feesOwing=newBill write.
                await recomputeStudentOwing(id, { transaction: t });
            }
            // If class didn't change, feesPaid/feesOwing are left untouched.

            return [studentRes, parentRes];
        });

        return response;
}

// BE-S4/BE-S5: SOFT DELETE. The previous version hard-destroyed the Student AND
// unconditionally destroyed the Parent (orphaning every child row and stranding
// siblings who share the parent). We now flag the student as archived in one
// transaction and leave the Parent + all child rows intact. Archived students
// are excluded from every read (getStudents / getParentContact filter isDeleted).
export const removeStudent = async (id) => {
    return await sequelize.transaction(async (t) => {
        const student = await Student.findOne({
            attributes: ["studentId"],
            where: { studentId: id },
            transaction: t,
        });
        if (!student) {
            throw new AppError("Student not found", 404);
        }

        await Student.update(
            { isDeleted: true, dateUpdated: new Date() },
            { where: { studentId: id }, transaction: t }
        );

        return { archived: true, studentId: Number(id) };
    });
}