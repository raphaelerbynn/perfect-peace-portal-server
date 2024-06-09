import sequelize from "../config/database.js";
import { Attendance, Term, TotalAttendance } from "../models/index.js";
import { getTerm } from "./term.js";

const createClassAttendance = async (data) => {
    const term = await getTerm()
    console.log("term :::", term)

    const attendance = await Attendance.create({
        studentId: data?.studentId,
        class: data?.class,
        status: data?.status,
        dateMarked: data?.dateMarked,
        dateEnd: data?.dateEnd,
        termId: term ? term.termId : null
    });

    return attendance;
}

const totalAttendanceMarked = async (data) => {
    const totalCount = await Attendance.count({
        where: {
          class: data?.class
        },
        group: ['dateMarked']
      });

    //   console.log("total :::", totalCount)
      return totalCount
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
        raw: true,
        order: [['studentId', 'ASC']]
    });

    console.log("response :::", response)

    return response;
}

const addTermAttendance = async () => {
    
    const term = await getTerm()

    const attendances = await Attendance.findAll({
        attributes: {
            include: [
                [sequelize.fn('SUM', sequelize.literal(`CASE WHEN status = 'Present' THEN 1 ELSE 0 END`)), 'present'],
                [sequelize.fn('SUM', sequelize.literal(`CASE WHEN status = 'Sick' THEN 1 ELSE 0 END`)), 'sick'],
                [sequelize.fn('SUM', sequelize.literal(`CASE WHEN status = 'Absent' THEN 1 ELSE 0 END`)), 'absent'],
                [sequelize.fn('COUNT', sequelize.col('status')), 'attendance']
            ],
            exclude: ['attendanceId', 'status', 'dateMarked', 'dateEnd']
        },
        raw: true,
        group: ['studentId']
    });

    // console.log("attendance :::", attendances)
    console.log("lrngth :::", attendances.length)

    const totalAttendancePromises = attendances?.map((attendance) => {
        const _totalAttendance = {
            studentId: attendance.studentId,
            present: attendance.present,
            sick: attendance.sick,
            attendance: attendance.attendance,
            termId: attendance.termId || term?.termId,
        }
        return TotalAttendance.create(_totalAttendance);
    });

    const results = await Promise.all([
        ...totalAttendancePromises
    ]);

    await Attendance.destroy()

    return results

}

export {
    createClassAttendance,
    removeAttendance,
    getAttendance,
    totalAttendanceMarked, 
    addTermAttendance
}