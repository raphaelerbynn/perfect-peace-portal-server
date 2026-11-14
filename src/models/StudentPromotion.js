import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

// B5: one promotion decision per pupil per term (the history).
const StudentPromotion = sequelize.define(
  "studentPromotion",
  {
    studentPromotionId: { autoIncrement: true, type: DataTypes.INTEGER, allowNull: false, primaryKey: true, field: "student_promotion_id" },
    studentId: { type: DataTypes.INTEGER, allowNull: false, field: "student_id" },
    termId: { type: DataTypes.INTEGER, allowNull: false, field: "term_id" },
    outcome: { type: DataTypes.STRING(10), allowNull: false, field: "outcome" },
    average: { type: DataTypes.DECIMAL(5, 2), allowNull: true, field: "average" },
    passMark: { type: DataTypes.DECIMAL(5, 2), allowNull: true, field: "pass_mark" },
    fromClassId: { type: DataTypes.INTEGER, allowNull: true, field: "from_class_id" },
    fromClassName: { type: DataTypes.STRING(50), allowNull: true, field: "from_class_name" },
    toClassId: { type: DataTypes.INTEGER, allowNull: true, field: "to_class_id" },
    toClassName: { type: DataTypes.STRING(50), allowNull: true, field: "to_class_name" },
    teacherRecommendation: { type: DataTypes.STRING(50), allowNull: true, field: "teacher_recommendation" },
    overridden: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: "overridden" },
    reason: { type: DataTypes.STRING(300), allowNull: true, field: "reason" },
    decidedBy: { type: DataTypes.STRING(100), allowNull: true, field: "decided_by" },
    decidedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: "decided_at" },
  },
  {
    sequelize,
    tableName: "Student_promotion",
    schema: "dbo",
    timestamps: false,
    indexes: [
      { name: "uniq_student_promotion", unique: true, fields: ["student_id", "term_id"] },
      { name: "idx_student_promotion_from", fields: ["term_id", "from_class_id"] },
    ],
  }
);

export default StudentPromotion;
