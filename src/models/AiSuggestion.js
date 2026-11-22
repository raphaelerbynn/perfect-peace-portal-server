import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

// AI-0 (migration 043): every AI result is a draft until a person accepts it.
// status PENDING | EDITED | ACCEPTED | REJECTED; content is per-feature JSON.
// created_by / reviewed_by = "OFFICE:<username>" or "STAFF:<teacherId>".
const AiSuggestion = sequelize.define(
  "aiSuggestion",
  {
    suggestionId: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, field: "suggestion_id" },
    feature: { type: DataTypes.STRING(30), allowNull: false, field: "feature" },
    entityType: { type: DataTypes.STRING(40), allowNull: false, field: "entity_type" },
    entityId: { type: DataTypes.STRING(60), allowNull: true, field: "entity_id" },
    field: { type: DataTypes.STRING(60), allowNull: true, field: "field" },
    content: { type: DataTypes.JSONB, allowNull: false, field: "content" },
    status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "PENDING", field: "status" },
    model: { type: DataTypes.STRING(60), allowNull: true, field: "model" },
    promptVersion: { type: DataTypes.STRING(60), allowNull: true, field: "prompt_version" },
    createdBy: { type: DataTypes.STRING(110), allowNull: true, field: "created_by" },
    reviewedBy: { type: DataTypes.STRING(110), allowNull: true, field: "reviewed_by" },
    reviewedAt: { type: DataTypes.DATE, allowNull: true, field: "reviewed_at" },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: "created_at" },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: "updated_at" },
  },
  { sequelize, tableName: "Ai_suggestion", schema: "dbo", timestamps: false }
);

export default AiSuggestion;
