import { Assignment } from "../models/index.js";


const uploadFileData = async (data, filename, file_id) => {
    return await Assignment.create({
        class: data.class,
        subject: data.subject,
        submissionDate: data.submissionDate,
        teacherId: data.teacherId,
        fileName: filename,
        fileData: file_id
    });
}


export { uploadFileData };