import { Op } from "sequelize";
import bcrypt from "bcrypt";
import sequelize from "../config/database.js";
import { Class, ClassFee, Parent, Student, StudentFee, Teacher, UserAccount } from "../models/index.js";
import { calculateAge } from "../utils/func.js";

const BCRYPT_ROUNDS = 10;

// Build the WHERE clause that identifies a management user WITHOUT involving the
// password. Login passes `username` (the typed username, which may be a
// `staff/123` index) and `category`. Signup also passes `staffId`.
const buildManagementIdentityWhere = (data) => {
    const identifiers = [];

    if (data?.username) {
        identifiers.push({ username: data.username });
        const idFromIndex = data.username.split("/")?.[1];
        if (idFromIndex) {
            identifiers.push({ teacherId: idFromIndex });
        }
    }
    if (data?.email) {
        identifiers.push({ email: data.email });
    }
    if (data?.staffId) {
        identifiers.push({ teacherId: data.staffId });
    }

    const where = {};
    if (identifiers.length) {
        where[Op.or] = identifiers;
    }
    if (data?.category) {
        where.category = data.category;
    }
    return where;
};

// Used by signup to detect an existing account (identity only, no password).
const findManagementUser = async (data) => {
    const where = buildManagementIdentityWhere(data);
    if (!where[Op.or]) {
        // No usable identifier supplied — treat as "not found".
        return null;
    }
    return await UserAccount.findOne({ where });
};

// Login: look the user up by identifier only, then verify the password with
// bcrypt. Never put the password in the WHERE clause.
const getManagementUser = async (data) => {
    const user = await findManagementUser(data);
    if (!user) {
        return null;
    }

    if (!user.password || !data?.password) {
        return null;
    }

    const passwordMatches = await bcrypt.compare(data.password, user.password);
    if (!passwordMatches) {
        return null;
    }

    return user;
}

const signUpManagementUser = async (data) => {
    const hashedPassword = await bcrypt.hash(data.password, BCRYPT_ROUNDS);
    return await UserAccount.create({
        username: data.username,
        email: data?.email || "",
        password: hashedPassword,
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

    //calculate age (real date diff — BE-25)
    student.age = calculateAge(student?.dob);

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

    // Explicitly list Teacher columns (excluding `password`) so the secret is
    // never returned to clients via this endpoint. Class columns are joined in full.
    const query = `SELECT
            \`dbo.Teacher\`.teacher_id,
            \`dbo.Teacher\`.f_name,
            \`dbo.Teacher\`.l_name,
            \`dbo.Teacher\`.gender,
            \`dbo.Teacher\`.phone,
            \`dbo.Teacher\`.email,
            \`dbo.Teacher\`.address,
            \`dbo.Teacher\`.class_id,
            \`dbo.Teacher\`.category,
            \`dbo.Teacher\`.salary_id,
            \`dbo.Teacher\`.staff_position,
            \`dbo.Teacher\`.ssnit_number,
            \`dbo.Teacher\`.tin_number,
            \`dbo.Teacher\`.bank,
            \`dbo.Teacher\`.account_number,
            \`dbo.Teacher\`.date_updated,
            \`dbo.Teacher\`.date_registered,
            \`dbo.Class\`.*
        FROM \`dbo.Teacher\`
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
        }
    })

    if (!result || !result.password || !password) {
        return null;
    }

    const passwordMatches = await bcrypt.compare(password, result.password);
    return passwordMatches ? result : null;
}

const getTeacherUser = async (id, password) => {
    const result = await Teacher.findOne({
        where: {
            teacher_id: id,
        }
    })

    if (!result || !result.password || !password) {
        return null;
    }

    const passwordMatches = await bcrypt.compare(password, result.password);
    return passwordMatches ? result : null;
}

const studentSignUp = async (id, password) => {
    const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
    return await Student.update(
        { password: hashedPassword },
        { where: {
            student_id: id,
            password: null
        }}
    )
}

const teacherSignUp = async (id, password) => {
    const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
    return await Teacher.update(
        { password: hashedPassword },
        { where: {
            teacher_id: id,
            password: null
        }}
    )
}

const changeTeacherPassword = async (id, password) => {
    const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
    return await Teacher.update(
        { password: hashedPassword },
        { where: {
            teacher_id: id
        }}
    )
}

const changeStudentPassword = async (id, password) => {
    const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
    return await Student.update(
        { password: hashedPassword },
        { where: {
            student_id: id
        }}
    )
}

const changeManagementUserPassword = async (id, password) => {
    const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
    return await UserAccount.update(
        { password: hashedPassword },
        { where: {
            teacherId: id
        }}
    )
}

export {

    getManagementUser,
    findManagementUser,
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