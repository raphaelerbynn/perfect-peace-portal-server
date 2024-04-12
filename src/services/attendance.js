import { Attendance } from "../models/index.js";

const createClassAttendance = async (data) => {
    const attendance = await Attendance.create({
        studentId: data?.studentId,
        class: data?.class,
        status: data?.status,
        dateMarked: data?.dateMarked,
        dateEnd: data?.dateEnd
    });

    return attendance;
}

const removeAttendance = async (data) => {
    // console.log(data)
    const response = await Attendance.destroy({
        where: {
            class: data?.class,
            dateMarked: data?.dateMarked
        }
    })

    return response;
}

const getAttendance = async (data) => {
    const response = await Attendance.findAll({
        where: {
            class: data?.class,
            dateMarked: data?.date,
        },
        order: [['studentId', 'ASC']]
    });

    return response;
}

export {
    createClassAttendance,
    removeAttendance,
    getAttendance
}