import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

// AI-1 (migration 044): one "Ask the school" thread, owned by one office user
// (user_ref = "OFFICE:<username>"). Only the owner can list, read or delete it.
const AiConversation = sequelize.define(
  "aiConversation",
  {
    conversationId: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, field: "conversation_id" },
    userRef: { type: DataTypes.STRING(110), allowNull: false, field: "user_ref" },
    title: { type: DataTypes.STRING(120), allowNull: false, field: "title" },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: "created_at" },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: "updated_at" },
  },
  { sequelize, tableName: "Ai_conversation", schema: "dbo", timestamps: false }
);

export default AiConversation;
