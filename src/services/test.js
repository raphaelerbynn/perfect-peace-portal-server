import { Class, ClassFee, KgAssessment, Parent, Student, StudentResult } from "../models/index.js";
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
                }
            ],
        });
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
        const allPromotedStudents = await StudentResult.findAll({
            attributes: ["studentId", "promotedTo"],
            where: {
                termId: term.termId,
                term: "3"
            },
            raw: true
        })
        allPromotedStudents.forEach(async (student) => {
            const response = await Student.update({
                classId: await getClassIdByName(student.promotedTo),
                class: student.promotedTo
            }, {
                where: {
                    studentId: student.studentId
                }
            });
        })
        console.log("🥳 Promoted students successfully")
        
        const allPromotedKgStudents = await KgAssessment.findAll({
            attributes: ["studentId", "promoted"],
            where: {
                termId: term.termId,
                term: "3",
                category: "Language Development (Reading, Listening and Oral Skills)"
            },
            raw: true
        })
        allPromotedKgStudents.forEach(async (student) => {
            const response = await Student.update({
                classId: await getClassIdByName(student.promoted),
                class: student.promoted
            }, {
                where: {
                    studentId: student.studentId
                }
            })
        })
        console.log("🥳 Promoted KG students successfully")
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
        
        const parent_id = await Student.findOne({
            attributes: ["parent_id"],
            where: {
                studentId: id
            }
        });

        // console.log(_class[0]?.dataValues?.class_id)
        const response = await Promise.allSettled([
            Student.update({
                fName: data.fName,
                mName: data.mName,
                lName: data.lName,
                dob: data.dob,
                gender: data.gender,
                class: data.class,
                feesPaid: 0,
                feesOwing: _class[0]?.dataValues?.fees,
                address: data.address,
                dateRegistered: Date.now(),
                classId: _class[0]?.dataValues?.class_id
            },
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
                    parent_id: parent_id.dataValues.parent_id
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