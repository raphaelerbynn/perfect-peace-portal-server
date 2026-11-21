import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

// B2: which teacher teaches which subject in which class, per term
// (db/migrations/024_teaching_assignments.sql). One teacher per
// (class, subject, term).
const TeachingAssignment = sequelize.define(
  "teachingAssignment",
  {
    teachingAssignmentId: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      field: "teaching_assignment_id",
    },
    teacherId: { type: DataTypes.INTEGER, allowNull: false, field: "teacher_id" },
    classId: { type: DataTypes.INTEGER, allowNull: false, field: "class_id" },
    subjectId: { type: DataTypes.INTEGER, allowNull: false, field: "subject_id" },
    termId: { type: DataTypes.INTEGER, allowNull: false, field: "term_id" },
    createdBy: { type: DataTypes.STRING(100), allowNull: true, field: "created_by" },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: "created_at" },
  },
  {
    sequelize,
    tableName: "Teaching_assignment",
    schema: "dbo",
    timestamps: false,
    indexes: [
      { name: "uniq_teaching_assignment", unique: true, fields: ["class_id", "subject_id", "term_id"] },
      { name: "idx_teaching_assignment_teacher", fields: ["teacher_id", "term_id"] },
    ],
  }
);

export default TeachingAssignment;
