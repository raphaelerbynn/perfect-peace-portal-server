import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

// AI-3 (migration 045): a question paper a teacher writes for one class +
// subject in one term. spec (JSON) holds topics and the sections; its shape is
// owned by services/papers.js. status DRAFT | FINAL (FINAL = read-only until
// the owner reopens it).
const QuestionPaper = sequelize.define(
  "questionPaper",
  {
    paperId: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, field: "paper_id" },
    teacherId: { type: DataTypes.INTEGER, allowNull: false, field: "teacher_id" },
    subjectId: { type: DataTypes.INTEGER, allowNull: false, field: "subject_id" },
    classId: { type: DataTypes.INTEGER, allowNull: false, field: "class_id" },
    termId: { type: DataTypes.INTEGER, allowNull: false, field: "term_id" },
    title: { type: DataTypes.STRING(150), allowNull: false, field: "title" },
    spec: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: "spec" },
    status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "DRAFT", field: "status" },
    finalisedAt: { type: DataTypes.DATE, allowNull: true, field: "finalised_at" },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: "created_at" },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: "updated_at" },
  },
  { sequelize, tableName: "Question_paper", schema: "dbo", timestamps: false }
);

export default QuestionPaper;
