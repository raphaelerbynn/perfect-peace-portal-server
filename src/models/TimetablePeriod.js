import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

// B3: the school's bell schedule (db/migrations/025_timetable.sql).
const TimetablePeriod = sequelize.define(
  "timetablePeriod",
  {
    periodId: { autoIncrement: true, type: DataTypes.INTEGER, allowNull: false, primaryKey: true, field: "period_id" },
    label: { type: DataTypes.STRING(40), allowNull: false, field: "label" },
    startTime: { type: DataTypes.STRING(5), allowNull: false, field: "start_time" },
    endTime: { type: DataTypes.STRING(5), allowNull: false, field: "end_time" },
    isBreak: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: "is_break" },
    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: "sort_order" },
  },
  { sequelize, tableName: "Timetable_period", schema: "dbo", timestamps: false }
);

export default TimetablePeriod;
