import { Class, ClassFee, KgAssessment, Parent, Student, StudentResult, StudentFee } from "../models/index.js";
import { isValidPhoneNumber } from "../utils/func.js";
import { getTerm } from "./term.js";

export const getStudents = async () => {
    try {
        const students = await Student.findAll({
            attributes: { exclude: ['password'] },
            include: [
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
            ],
            raw: true
        });
        //calculate age for each student
        const currentYear = new Date().getFullYear();
        students.forEach(student => {
            const birthDate = new Date(student?.dob);
            const age = currentYear - birthDate.getFullYear();
            student.age = age;
        })
        return students
    } catch (error) {
        console.log(error);
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

export const promoteStudents = async () => {
    const term = await getTerm()
    try {
        // --- Basic class students (StudentResult) ---
        const allPromotedStudents = await StudentResult.findAll({
            attributes: ["studentId", "promotedTo"],
            where: {
                termId: term.termId,
                term: "3"
            },
            raw: true
        })

        const basicPromises = allPromotedStudents
            .filter(s => s.promotedTo) // skip students without a promotedTo value
            .map(async (student) => {
                try {
                    const newClassId = await getClassIdByName(student.promotedTo);
                    if (newClassId == null) {
                        console.warn(`⚠️ Class "${student.promotedTo}" not found for student ${student.studentId}, skipping`);
                        return;
                    }
                    await Student.update(
                        { classId: newClassId, class: student.promotedTo },
                        { where: { studentId: student.studentId } }
                    );
                } catch (err) {
                    console.error(`❌ Failed to promote student ${student.studentId}:`, err.message);
                }
            });

        await Promise.all(basicPromises);
        console.log(`🥳 Promoted ${basicPromises.length} basic-class students`)
        
        // --- KG / Nursery students (KgAssessment) ---
        const allPromotedKgStudents = await KgAssessment.findAll({
            attributes: ["studentId", "promoted"],
            where: {
                termId: term.termId,
                term: "3",
                category: "Language Development (Reading, Listening and Oral Skills)"
            },
            raw: true
        })

        const kgPromises = allPromotedKgStudents
            .filter(s => s.promoted) // skip students without a promoted value
            .map(async (student) => {
                try {
                    const newClassId = await getClassIdByName(student.promoted);
                    if (newClassId == null) {
                        console.warn(`⚠️ Class "${student.promoted}" not found for KG student ${student.studentId}, skipping`);
                        return;
                    }
                    await Student.update(
                        { classId: newClassId, class: student.promoted },
                        { where: { studentId: student.studentId } }
                    );
                } catch (err) {
                    console.error(`❌ Failed to promote KG student ${student.studentId}:`, err.message);
                }
            });

        await Promise.all(kgPromises);
        console.log(`🥳 Promoted ${kgPromises.length} KG students`)
        return
    } catch (error) {
        console.log(error);
    }
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

        // Build update payload — only reset fees when class actually changes
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

        if (classChanged) {
            // Recalculate feesOwing for the new class:
            // sum of new class fees + existing student-specific fees + any previous arrears
            const classFees = await ClassFee.findAll({ where: { classId: newClassId }, raw: true });
            const studentFees = await StudentFee.findAll({ where: { studentId: id }, raw: true });
            const classFeeTotal = classFees.reduce((sum, f) => sum + Number(f.amount || 0), 0);
            const studentFeeTotal = studentFees.reduce((sum, f) => sum + Number(f.amount || 0), 0);
            const newBillTotal = classFeeTotal + studentFeeTotal;

            // Previous arrears: what they still owe minus the old class bill
            // Since we're changing class, reset to new bill (arrears are lost on class change)
            studentUpdate.feesOwing = newBillTotal;
            studentUpdate.feesPaid = 0;
        }
        // If class didn't change, feesPaid and feesOwing remain untouched

        const response = await Promise.allSettled([
            Student.update(studentUpdate,
            {
                where: {
                    studentId: id
                }
            }
            ),
            Parent.update({
                fName: data.pfName,
                lName: data.plName,
                gender: data.pGender,
                contact: data.contact,
                contact1: data.contact1,
                relationship: data.relationship,
                occupation: data.occupation,
            },
            {
                where: {
                    parent_id: parent_id
                }
            }
            ),
        ]);

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