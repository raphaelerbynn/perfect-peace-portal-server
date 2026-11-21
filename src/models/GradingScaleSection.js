import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

// B8: which scale grades a class section (Class.section, e.g. "JHS").
// One scale per section; sections with no row use the default scale.
const GradingScaleSection = sequelize.define(
  "gradingScaleSection",
  {
    section: { type: DataTypes.STRING(50), allowNull: false, primaryKey: true, field: "section" },
    gradingScaleId: { type: DataTypes.INTEGER, allowNull: false, field: "grading_scale_id" },
  },
  { sequelize, tableName: "Grading_scale_section", schema: "dbo", timestamps: false }
);

export default GradingScaleSection;
