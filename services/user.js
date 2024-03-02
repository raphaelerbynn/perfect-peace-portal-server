import sequelize from "../config/database.js";
import { Student, Teacher, UserAccount } from "../models/index.js";


const getManagementUser = async (username, password, category) => {
    const test = await UserAccount.findAll();
    console.log("test::::", test)
    const result = await UserAccount.findOne({
        where: {
            username: username,
            password: password,
            category: category,
        }
    })

    return result;
}


//portal
const getStudentDetails = async (indexNumber) => {

    const query = `SELECT TOP 1
    Student.*,
    Student.student_id,
    Student.class_id,
    Student.f_name AS f_name,
    Student.m_name AS m_name,
    Student.l_name AS l_name,
    Parent.f_name AS pf_name,
    Parent.l_name AS pl_name,
    Parent.contact,
    Parent.contact1,
    Parent.relationship,
    Parent.occupation,
    Class.tuition,
    Class.firstAid,
    Class.pta,
    Class.water,
    Class.maintenance,
    Class.stationary,
    Class.cocurricular,
    Class.fees AS fees
  FROM
    Student
  LEFT JOIN
    Parent ON Student.parent_id = Parent.parent_id
  LEFT JOIN
    Fee ON Student.student_id = Fee.student_id
  LEFT JOIN
    Class ON Student.class_id = Class.class_id
  WHERE
    Student.student_id = :indexNumber
  ORDER BY
    Fee.fee_id DESC`

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

    const query = `SELECT  * FROM Teacher
    LEFT JOIN
       Class ON Teacher.teacher_id = Class.teacher_id
         WHERE Teacher.teacher_id = :id`;

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