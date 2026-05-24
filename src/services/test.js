import { Class, ClassFee, KgAssessment, Parent, Student, StudentResult, StudentFee } from "../models/index.js";
import sequelize from "../config/database.js";
import { isValidPhoneNumber, calculateAge } from "../utils/func.js";
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
    // central errorHandler (proper 500). Success-path shape is unchanged.
    {
        const { page, limit, lite } = options;

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
            include,
            raw: true,
        };

        // Apply limit/offset only when pagination params are supplied.
        const parsedLimit = parseInt(limit, 10);
        const parsedPage = parseInt(page, 10);
        if (Number.isInteger(parsedLimit) && parsedLimit > 0) {
            queryOptions.limit = parsedLimit;
            const safePage = Number.isInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
            queryOptions.offset = (safePage - 1) * parsedLimit;
            // `subQuery: false` keeps limit/offset on the top-level Student query
            // when hasMany associations are included, so the count is correct.
            queryOptions.subQuery = false;
        }

        const students = await Student.findAll(queryOptions);
        //calculate age for each student (real date diff — BE-25)
        students.forEach(student => {
            student.age = calculateAge(student?.dob);
        })
        return students
    }
}

export const getParentContact = async (id, forAttendance=false, status="") => {
    try {
        const student = await Student.findOne({
            attributes: ["fName", "mName", "lName"],
            where: {
                studentId: id
            },
            include: [
                {
                    model: Parent,
                    as: "parent",
                }
            ],
        });
        
        const contacts = []
        if (student) {
            const { contact, contact1 } = student.parent;
            if (isValidPhoneNumber(contact)) {
                contacts.push(contact);
            }
            if (isValidPhoneNumber(contact1)) {
                contacts.push(contact1);
            }
        }
        // console.log(contacts)
        return forAttendance ? { childName: `${student.fName} ${student.mName} ${student.lName}`, contact: contacts?.[0], status: status.toLowerCase() } : contacts;
    } catch (error) {
        console.log(error);
    }
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
    try {
        const _class = await Class.findOne({
            attributes: ["class_id"],
            where: {
                name: data.class
            }
        });

        console.log(_class)
        // return

        await Promise.allSettled([
            Student.create({
                fName: data.fName,
                mName: data.mName,
                lName: data.lName,
                dob: data.dob,
                gender: data.gender,
                class: data.class,
                feesPaid: 0,
                address: data.address,
                dateRegistered: Date.now(),
                classId: _class?.classId || _class?.class_id || _class?.dataValues?.class_id || _class?.dataValues?.classId
            }),
            Parent.create({
                fName: data.pfName,
                lName: data.plName,
                gender: data.pGender,
                contact: data.contact,
                contact1: data.contact1,
                relationship: data.relationship,
                occupation: data.occupation,
            }),
        ]);

        const lastParentId = await Parent.findOne({
            attributes: ["parent_id"],
            order: [["parent_id", "DESC"]]
        });

        const lastStudentId = await Student.findOne({
            attributes: ["student_id"],
            order: [["student_id", "DESC"]]
        });

        const response = await Student.update(
            {
                parentId: lastParentId.dataValues.parent_id,
            },
            {
                where: {
                    studentId: lastStudentId.dataValues.student_id,
                }
            }
        );

        return response;

    } catch (error) {
        console.log(error);
    }
}

export const editStudent = async (data, id) => {
    try {
        const _class = await Class.findAll({
            attributes: ["class_id", "fees"],
            where: {
                name: data.class
            }
        });

        const currentStudent = await Student.findOne({
            where: { studentId: id }
        });

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
            classId: newClassId
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

    } catch (error) {
        console.log(error);
    }
}

export const removeStudent = async (id) => {
    try {
        
        const parent_id = await Student.findOne({
            attributes: ["parent_id"],
            where: {
                studentId: id
            }
        });

        const response = await Promise.allSettled([
            Student.destroy({
                where: {
                    studentId: id
                }
            }),
            Parent.destroy(
            {
                where: {
                    parent_id: parent_id.dataValues.parent_id
                }
            }),
        ]);

        return response;

    } catch (error) {
        console.log(error);
    }
}