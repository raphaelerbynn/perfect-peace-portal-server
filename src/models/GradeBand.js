import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

// B8: one band of a grading scale, on the 0–100 subject total
// (db/migrations/032_grading_scales.sql). grade is optional (primary prints
// the remark only; JHS prints 1–9).
const GradeBand = sequelize.define(
  "gradeBand",
  {
    gradeBandId: { autoIncrement: true, type: DataTypes.INTEGER, allowNull: false, primaryKey: true, field: "grade_band_id" },
    gradingScaleId: { type: DataTypes.INTEGER, allowNull: false, field: "grading_scale_id" },
    grade: { type: DataTypes.STRING(10), allowNull: true, field: "grade" },
    remark: { type: DataTypes.STRING(50), allowNull: false, field: "remark" },
    minScore: { type: DataTypes.DECIMAL(5, 2), allowNull: false, field: "min_score" },
    maxScore: { type: DataTypes.DECIMAL(5, 2), allowNull: false, field: "max_score" },
  },
  { sequelize, tableName: "Grade_band", schema: "dbo", timestamps: false }
);

export default GradeBand;
