import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

// B9 (migration 036): one staff member's mark for one day. No row = unmarked.
// status: PRESENT | ABSENT | LATE | SICK | ON_LEAVE | PERMISSION (VARCHAR, so
// no CHAR padding). timeIn: optional "HH:mm".
const StaffAttendance = sequelize.define(
  "staffAttendance",
  {
    staffAttendanceId: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, field: "staff_attendance_id" },
    teacherId: { type: DataTypes.INTEGER, allowNull: false, field: "teacher_id" },
    termId: { type: DataTypes.INTEGER, allowNull: false, field: "term_id" },
    date: { type: DataTypes.DATEONLY, allowNull: false, field: "date" },
    status: { type: DataTypes.STRING(12), allowNull: false, field: "status" },
    timeIn: { type: DataTypes.STRING(5), allowNull: true, field: "time_in" },
    remarks: { type: DataTypes.STRING(300), allowNull: true, field: "remarks" },
    markedBy: { type: DataTypes.STRING(100), allowNull: true, field: "marked_by" },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: "created_at" },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: "updated_at" },
  },
  {
    sequelize,
    tableName: "Staff_attendance",
    schema: "dbo",
    timestamps: false,
    indexes: [
      { name: "staff_attendance_teacher_date_uq", unique: true, fields: ["teacher_id", "date"] },
      { name: "staff_attendance_term_idx", fields: ["term_id"] },
      { name: "staff_attendance_date_idx", fields: ["date"] },
    ],
  }
);

export default StaffAttendance;
