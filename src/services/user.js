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
    // BE-T3: a management account whose staff record was archived is disabled.
    where.isDeleted = { [Op.not]: true };
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
// BE-A13: never hand the bcrypt hash back to the caller — return a sanitized
// plain object with the password stripped after the compare.
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

    const { password, ...safe } = user.get({ plain: true });
    return safe;
}

// BE-A1: confirm a management UserAccount EXISTS for a given staff/teacher id,
// without involving the password. Used by the OTP flow to decide whether to
// actually send an SMS (the HTTP response stays generic either way — BE-A9).
const managementUserExistsForStaff = async (staffId) => {
    if (!staffId) {
        return false;
    }
    const user = await UserAccount.findOne({ where: { teacherId: staffId } });
    return Boolean(user);
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
            t.teacher_id,
            t.f_name,
            t.l_name,
            t.gender,
            t.phone,
            t.email,
            t.address,
            t.class_id,
            t.category,
            t.salary_id,
            t.staff_position,
            t.ssnit_number,
            t.tin_number,
            t.bank,
            t.account_number,
            t.date_updated,
            t.date_registered,
            c.*
        FROM "dbo"."Teacher" t
    LEFT JOIN
       "dbo"."Class" c ON t.teacher_id = c.teacher_id
         WHERE t.teacher_id = :id`;

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
            // Archived (soft-deleted) students cannot log in.
            isDeleted: { [Op.not]: true },
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
            // BE-T3: archived (soft-deleted) staff cannot log in to the portal.
            isDeleted: { [Op.not]: true },
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
    managementUserExistsForStaff,
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