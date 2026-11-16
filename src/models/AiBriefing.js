import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

// AI-5 (migration 046): one Monday briefing per day. runKey = the Africa/Accra
// date (YYYY-MM-DD), UNIQUE, so a restart or a second instance can't make two.
// status RUNNING | QUIET | READY | FAILED; source AI | PLAIN (+ fallbackReason
// QUOTA | AI_OFF | AI_FAILED); signals / content / delivered are JSON.
const AiBriefing = sequelize.define(
  "aiBriefing",
  {
    briefingId: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, field: "briefing_id" },
    runKey: { type: DataTypes.STRING(40), allowNull: false, field: "run_key" }, // UNIQUE: ai_briefing_run_key_unique (migration 046)
    briefingDate: { type: DataTypes.DATEONLY, allowNull: false, field: "briefing_date" },
    status: { type: DataTypes.STRING(10), allowNull: false, field: "status" },
    source: { type: DataTypes.STRING(10), allowNull: true, field: "source" },
    fallbackReason: { type: DataTypes.STRING(20), allowNull: true, field: "fallback_reason" },
    signals: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: "signals" },
    content: { type: DataTypes.JSONB, allowNull: true, field: "content" },
    delivered: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: "delivered" },
    model: { type: DataTypes.STRING(60), allowNull: true, field: "model" },
    promptVersion: { type: DataTypes.STRING(60), allowNull: true, field: "prompt_version" },
    costGhs: { type: DataTypes.DECIMAL(12, 4), allowNull: false, defaultValue: 0, field: "cost_ghs" },
    error: { type: DataTypes.STRING(300), allowNull: true, field: "error" },
    runTrigger: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "SCHEDULE", field: "run_trigger" },
    runBy: { type: DataTypes.STRING(110), allowNull: true, field: "run_by" },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: "created_at" },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: "updated_at" },
  },
  { sequelize, tableName: "Ai_briefing", schema: "dbo", timestamps: false }
);

export default AiBriefing;
