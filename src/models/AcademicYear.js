import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

// B7 (migration 029): a school year that groups terms, e.g. "2026/2027".
const AcademicYear = sequelize.define(
  "academicYear",
  {
    academicYearId: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, field: "academic_year_id" },
    name: { type: DataTypes.STRING(50), allowNull: false, field: "name" },
    startDate: { type: DataTypes.DATEONLY, allowNull: false, field: "start_date" },
    endDate: { type: DataTypes.DATEONLY, allowNull: false, field: "end_date" },
    // UPCOMING | ACTIVE | COMPLETED
    status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "UPCOMING", field: "status" },
    isCurrent: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: "is_current" },
  },
  {
    sequelize,
    tableName: "Academic_year",
    schema: "dbo",
    timestamps: false,
  }
);

export default AcademicYear;
