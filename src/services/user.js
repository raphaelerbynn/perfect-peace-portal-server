import { Op } from "sequelize";
import sequelize from "../config/database.js";
import { Student, Teacher, UserAccount } from "../models/index.js";


const getManagementUser = async (data) => {
    // const test = await UserAccount.findAll();
    // console.log("test::::", test)
    const result = await UserAccount.findOne({
        where: {
            [Op.or]: [
                { username: data?.username || "" },
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

    const query = `SELECT
    \`dbo.Student\`.*,
    \`dbo.Student\`.student_id,
    \`dbo.Student\`.class_id,
    \`dbo.Student\`.f_name AS f_name,
    \`dbo.Student\`.m_name AS m_name,
    \`dbo.Student\`.l_name AS l_name,
    \`dbo.Parent\`.f_name AS pf_name,
    \`dbo.Parent\`.l_name AS pl_name,
    \`dbo.Parent\`.contact,
    \`dbo.Parent\`.contact1,
    \`dbo.Parent\`.relationship,
    \`dbo.Parent\`.occupation,
    \`dbo.Class\`.tuition,
    \`dbo.Class\`.firstAid,
    \`dbo.Class\`.pta,
    \`dbo.Class\`.water,
    \`dbo.Class\`.maintenance,
    \`dbo.Class\`.stationary,
    \`dbo.Class\`.cocurricular,
    \`dbo.Class\`.fees AS fees
  FROM
    \`dbo.Student\`
  LEFT JOIN
    \`dbo.Parent\` ON \`dbo.Student\`.parent_id = \`dbo.Parent\`.parent_id
  LEFT JOIN
    \`dbo.Fee\` ON \`dbo.Student\`.student_id = \`dbo.Fee\`.student_id
  LEFT JOIN
    \`dbo.Class\` ON \`dbo.Student\`.class_id = \`dbo.Class\`.class_id
  WHERE
    \`dbo.Student\`.student_id = :indexNumber
  ORDER BY
    \`dbo.Fee\`.fee_id DESC
  LIMIT 1`

    const results = await sequelize.query(query, {
        replacements: { indexNumber },
        type: sequelize.QueryTypes.SELECT
    });


    return results;
        
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
            student_id: id,
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


export {

    getManagementUser,
    signUpManagementUser,

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