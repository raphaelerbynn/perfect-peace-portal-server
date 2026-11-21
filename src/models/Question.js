import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

// AI-3 (migration 045): one question on a question paper, by section (1-based,
// matching the paper's spec.sections) and position within the section.
// origin AI | AI_EDITED | TEACHER. checker_disagrees: the blind second AI pass
// answered differently from the key (checker_answer).
const Question = sequelize.define(
  "question",
  {
    questionId: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, field: "question_id" },
    paperId: { type: DataTypes.INTEGER, allowNull: false, field: "paper_id" },
    section: { type: DataTypes.SMALLINT, allowNull: false, field: "section" },
    position: { type: DataTypes.SMALLINT, allowNull: false, field: "position" },
    type: { type: DataTypes.STRING(15), allowNull: false, field: "type" },
    stem: { type: DataTypes.TEXT, allowNull: false, field: "stem" },
    options: { type: DataTypes.JSONB, allowNull: true, field: "options" },
    answer: { type: DataTypes.JSONB, allowNull: true, field: "answer" },
    markingScheme: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: "marking_scheme" },
    explanation: { type: DataTypes.TEXT, allowNull: true, field: "explanation" },
    marks: { type: DataTypes.DECIMAL(6, 2), allowNull: false, field: "marks" },
    difficulty: { type: DataTypes.STRING(10), allowNull: true, field: "difficulty" },
    origin: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "TEACHER", field: "origin" },
    checkerDisagrees: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: "checker_disagrees" },
    checkerAnswer: { type: DataTypes.STRING(200), allowNull: true, field: "checker_answer" },
    promptVersion: { type: DataTypes.STRING(60), allowNull: true, field: "prompt_version" },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: "created_at" },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: "updated_at" },
  },
  { sequelize, tableName: "Question", schema: "dbo", timestamps: false }
);

export default Question;
