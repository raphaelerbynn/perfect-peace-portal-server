import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

// B12 (migration 031): a pupil's discount, from a term onward (toTermId null = until ended).
const StudentDiscount = sequelize.define(
  "studentDiscount",
  {
    studentDiscountId: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, field: "student_discount_id" },
    studentId: { type: DataTypes.INTEGER, allowNull: false, field: "student_id" },
    discountTypeId: { type: DataTypes.INTEGER, allowNull: false, field: "discount_type_id" },
    fromTermId: { type: DataTypes.INTEGER, allowNull: false, field: "from_term_id" },
    toTermId: { type: DataTypes.INTEGER, allowNull: true, field: "to_term_id" },
    // MANUAL | SIBLING
    source: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "MANUAL", field: "source" },
    reason: { type: DataTypes.STRING(300), allowNull: true, field: "reason" },
    createdBy: { type: DataTypes.STRING(100), allowNull: true, field: "created_by" },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: "created_at" },
  },
  { sequelize, tableName: "Student_discount", schema: "dbo", timestamps: false }
);

export default StudentDiscount;
