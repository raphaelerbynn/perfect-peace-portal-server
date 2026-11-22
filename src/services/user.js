import { Op } from "sequelize";
import bcrypt from "bcrypt";
import sequelize from "../config/database.js";
import { Class, ClassFee, Parent, Student, StudentFee, Teacher, UserAccount } from "../models/index.js";
import { calculateAge } from "../utils/func.js";
import { AppError } from "../utils/errorHandling.js";

const BCRYPT_ROUNDS = 10;

// Build the WHERE clause that identifies a management user WITHOUT involving the
// password. Login passes `username` (the typed username, which may be a
// `staff/123` index) and `category`. Signup also passes `staffId`.
const buildManagementIdentityWhere = (data) => {
    const identifiers = [];

    // Case- and space-insensitive, as the live MySQL collation was: "Admin "
    // and "admin" are the same account after the move to Postgres too.
    const sameText = (column, value) =>
        sequelize.where(sequelize.fn("lower", sequelize.fn("trim", sequelize.col(column))), String(value).trim().toLowerCase());
    if (data?.username) {
        identifiers.push(sameText("username", data.username));
        const idFromIndex = String(data.username).split("/")?.[1]?.trim();
        if (idFromIndex && /^\d+$/.test(idFromIndex)) {
            identifiers.push({ teacherId: idFromIndex });
        }
    }
    if (data?.email) {
        identifiers.push(sameText("email", data.email));
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
        // No usable identifier supplied - treat as "not found".
        return null;
    }
    return await UserAccount.findOne({ where });
};

// Login: look the user up by identifier only, then verify the password with
// bcrypt. Never put the password in the WHERE clause.
// BE-A13: never hand the bcrypt hash back to the caller - return a sanitized
// plain object with the password stripped after the compare.
// B10: one office login form. Without a category the account is found by
// username / email / staff/<id> across every role. An exact username wins; a
// staff member with several office logins whose password matches more than
// one is asked for the username (409). Old clients still send a category,
// which narrows the search as before.
const norm = (v) => String(v ?? "").trim().toLowerCase();
const MAX_CANDIDATES = 10;

const getManagementUser = async (data) => {
    const where = buildManagementIdentityWhere(data);
    if (!where[Op.or] || !data?.password) {
        return null;
    }
    const rows = await UserAccount.findAll({ where, limit: MAX_CANDIDATES });
    if (!rows.length) {
        return null;
    }
    const exact = rows.filter((r) => norm(r.username) === norm(data.username));
    const candidates = exact.length ? exact : rows;

    const matches = [];
    for (const row of candidates) {
        if (row.password && (await bcrypt.compare(data.password, row.password))) matches.push(row);
    }
    if (matches.length > 1) {
        throw new AppError("This staff member has more than one office login. Sign in with the username instead.", 409);
    }
    if (!matches.length) {
        return null;
    }

    const { password, ...safe } = matches[0].get({ plain: true });
    return safe;
}

// BE-A1: confirm a management UserAccount EXISTS for a given staff/teacher id,
// without involving the password. Used by the OTP flow to decide whether to
// actually send an SMS (the HTTP response stays generic either way - BE-A9).
const managementUserExistsForStaff = async (staffId) => {
    if (!staffId) {
        return false;
    }
    const user = await UserAccount.findOne({ where: { teacherId: staffId } });
    return Boolean(user);
}

// B10: roleId is the login's role; category is kept equal to the role's name.
const signUpManagementUser = async (data) => {
    const hashedPassword = await bcrypt.hash(data.password, BCRYPT_ROUNDS);
    return await UserAccount.create({
        username: data.username,
        email: data?.email || "",
        password: hashedPassword,
        teacherId: data.staffId,
        category: data.category,
        roleId: data.roleId ?? null,
    })
}


//portal
const getStudentDetails = async (indexNumber) => {
    const student = await Student.findOne({
        // Never send the password hash to the browser (GET /user-details).
        attributes: { exclude: ["password", "photoKey", "photoThumbKey"] }, // B17: no storage keys
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

    //calculate age (real date diff - BE-25)
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