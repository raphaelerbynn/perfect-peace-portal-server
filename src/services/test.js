import { Class, ClassFee, Parent, Student } from "../models/index.js";

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

export const createStudent = async (data) => {
    try {
        const _class = await Class.findAll({
            attributes: ["class_id", "fees"],
            where: {
                name: data.class
            }
        });

        await Promise.allSettled([
            Student.create({
                fName: data.fName,
                mName: data.mName,
                lName: data.lName,
                dob: data.dob,
                gender: data.gender,
                class: data.class,
                feesPaid: 0,
                feesOwing: _class[0]?.fees,
                address: data.address,
                dateRegistered: Date.now(),
                classId: _class[0]?.classId
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