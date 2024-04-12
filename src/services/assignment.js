import { Assignment } from "../models/index.js";


const getAssignmentStudent = async (student_class) => {
    return await Assignment.findAll({
        where: {
            class: student_class
        }
    });
}

const getAssignmentTeacher = async (teacher_id) => {
    return await Assignment.findAll({
        where: {
            teacher_id: teacher_id
        }
    });
}

const deleteAssignment = async (id, fileData) => {
    return await Assignment.destroy({
        where: {
            teacher_id: id,
            fileData: fileData,
        }
    })
}


export {
    getAssignmentStudent,
    getAssignmentTeacher,
    deleteAssignment
};