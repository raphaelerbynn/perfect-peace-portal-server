import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

// B8: a grading scale (db/migrations/032_grading_scales.sql). Exactly one is
// the default; the others are linked to class sections (GradingScaleSection).
const GradingScale = sequelize.define(
  "gradingScale",
  {
    gradingScaleId: { autoIncrement: true, type: DataTypes.INTEGER, allowNull: false, primaryKey: true, field: "grading_scale_id" },
    name: { type: DataTypes.STRING(100), allowNull: false, field: "name" },
    isDefault: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: "is_default" },
  },
  { sequelize, tableName: "Grading_scale", schema: "dbo", timestamps: false }
);

export default GradingScale;
