import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

// AI-1 (migration 044): a question (USER) or an answer (ASSISTANT) in an
// Ai_conversation. user_ref is copied on every row for the per-user hourly
// limit. status OK | STOPPED | ERROR; fast_path = answered without the AI.
const AiMessage = sequelize.define(
  "aiMessage",
  {
    messageId: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, field: "message_id" },
    conversationId: { type: DataTypes.INTEGER, allowNull: false, field: "conversation_id" },
    userRef: { type: DataTypes.STRING(110), allowNull: false, field: "user_ref" },
    role: { type: DataTypes.STRING(10), allowNull: false, field: "role" },
    content: { type: DataTypes.TEXT, allowNull: false, field: "content" },
    toolsUsed: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: "tools_used" },
    fastPath: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: "fast_path" },
    status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "OK", field: "status" },
    promptVersion: { type: DataTypes.STRING(60), allowNull: true, field: "prompt_version" },
    costGhs: { type: DataTypes.DECIMAL(12, 4), allowNull: false, defaultValue: 0, field: "cost_ghs" },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: "created_at" },
  },
  { sequelize, tableName: "Ai_message", schema: "dbo", timestamps: false }
);

export default AiMessage;
