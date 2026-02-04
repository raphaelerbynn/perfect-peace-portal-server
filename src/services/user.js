import { Op } from "sequelize";
import sequelize from "../config/database.js";
import { Class, ClassFee, Parent, Student, StudentFee, Teacher, UserAccount } from "../models/index.js";


const getManagementUser = async (data) => {
    const result = await UserAccount.findOne({
        where: {
            [Op.or]: [
                { username: data?.username || "" },
                { teacherId: data?.username?.split("/")?.[1] || "" },
                { email: data?.email || "" },
                { teacherId: data?.staffId || -1}
            ],
            password: data?.password,
            category: data?.category,
        }
    })

    return result;
}

const signUpManagementUser = async (data) => {
    return await UserAccount.create({
        username: data.username,
        email: data?.email || "",
        password: data.password,
        teacherId: data.staffId,
        category: data.category
    })
}


//portal
const getStudentDetails = async (indexNumber) => {
    const student = await Student.findOne({
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
            },
        ],
        where: {
            student_id: indexNumber,
        },
        raw: false,
    });

    // If a student has a custom fee list, prefer it over the class fee list
    // if (student && student[0]) {
    //     const s = student[0];
    //     const customFees = s?.dataValues?.studentFee;
    //     if (customFees && Array.isArray(customFees) && customFees.length > 0) {
    //         if (s.dataValues.class_) {
    //             s.dataValues.class_.dataValues.classFee = customFees;
    //         }
    //     }
    // }

    //calculate age
    const currentYear = new Date().getFullYear();
    const birthDate = new Date(student?.dob);
    const age = currentYear - birthDate.getFullYear();
    student.age = age;

    return student;
        
}

const getStudentClass = async (id) => {
    return await Student.findAll({
        attributes: ["class"],
        where: {
            student_id: id
        }
    });
}

const getTeacherDetails = async (id) => {

    const query = `SELECT  * FROM \`dbo.Teacher\`
    LEFT JOIN
       \`dbo.Class\` ON \`dbo.Teacher\`.teacher_id = \`dbo.Class\`.teacher_id
         WHERE \`dbo.Teacher\`.teacher_id = :id`;

    const results = await sequelize.query(query, {
        replacements: { id },
        type: sequelize.QueryTypes.SELECT
    });


    return results;
        
}


const getStudentUser = async (id, password) => {
    const result = await Student.findOne({
        where: {
            student_id: id,
            password: password,
        }
    })

    return result;
}

const getTeacherUser = async (id, password) => {
    const result = await Teacher.findOne({
        where: {
            teacher_id: id,
            password: password
        }
    })

    return result;
}

const studentSignUp = async (id, password) => {
    return await Student.update(
        { password },
        { where: {
            student_id: id,
            password: null
        }}
    )
}

const teacherSignUp = async (id, password) => {
    return await Teacher.update(
        { password },
        { where: {
            teacher_id: id,
            password: null
        }}
    )
}

const changeTeacherPassword = async (id, password) => {
    return await Teacher.update(
        { password },
        { where: {
            teacher_id: id
        }}
    )
}

const changeStudentPassword = async (id, password) => {
    return await Student.update(
        { password },
        { where: {
            student_id: id
        }}
    )
}

const changeManagementUserPassword = async (id, password) => {
    return await UserAccount.update(
        { password: password },
        { where: {
            teacherId: id
        }}
    )
}

export {

    getManagementUser,
    signUpManagementUser,
    changeManagementUserPassword,

    //portal
    getStudentDetails,
    getTeacherDetails,
    getStudentUser,
    getTeacherUser,
    studentSignUp,
    teacherSignUp,
    changeTeacherPassword,
    changeStudentPassword,
    getStudentClass
}