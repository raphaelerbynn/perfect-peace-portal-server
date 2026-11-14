import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

// B3: one lesson on the timetable (db/migrations/025_timetable.sql).
// day: 1 = Monday ... 5 = Friday. Times are "HH:mm" (24-hour).
const TimetableEntry = sequelize.define(
  "timetableEntry",
  {
    timetableEntryId: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      field: "timetable_entry_id",
    },
    termId: { type: DataTypes.INTEGER, allowNull: false, field: "term_id" },
    classId: { type: DataTypes.INTEGER, allowNull: false, field: "class_id" },
    subjectId: { type: DataTypes.INTEGER, allowNull: false, field: "subject_id" },
    teacherId: { type: DataTypes.INTEGER, allowNull: false, field: "teacher_id" },
    day: { type: DataTypes.SMALLINT, allowNull: false, field: "day" },
    startTime: { type: DataTypes.STRING(5), allowNull: false, field: "start_time" },
    endTime: { type: DataTypes.STRING(5), allowNull: false, field: "end_time" },
    room: { type: DataTypes.STRING(50), allowNull: true, field: "room" },
    notes: { type: DataTypes.STRING(200), allowNull: true, field: "notes" },
    createdBy: { type: DataTypes.STRING(100), allowNull: true, field: "created_by" },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: "created_at" },
  },
  {
    sequelize,
    tableName: "Timetable_entry",
    schema: "dbo",
    timestamps: false,
    indexes: [
      { name: "idx_timetable_term_class", fields: ["term_id", "class_id", "day"] },
      { name: "idx_timetable_teacher_term_day", fields: ["teacher_id", "term_id", "day"] },
    ],
  }
);

export default TimetableEntry;
