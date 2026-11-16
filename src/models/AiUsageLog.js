import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

// AI-0 (migration 043): one row per model call, and per refused call.
// cost_micros = estimated USD in millionths; cost_ghs = the same in cedis at the
// AI_USD_TO_GHS rate when it was recorded (the monthly cap sums this).
const AiUsageLog = sequelize.define(
  "aiUsageLog",
  {
    usageId: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, field: "usage_id" },
    feature: { type: DataTypes.STRING(30), allowNull: false, field: "feature" },
    userRef: { type: DataTypes.STRING(110), allowNull: true, field: "user_ref" },
    model: { type: DataTypes.STRING(60), allowNull: false, field: "model" },
    promptVersion: { type: DataTypes.STRING(60), allowNull: true, field: "prompt_version" },
    inputTokens: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: "input_tokens" },
    cachedTokens: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: "cached_tokens" },
    outputTokens: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: "output_tokens" },
    costMicros: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: "cost_micros" },
    costGhs: { type: DataTypes.DECIMAL(12, 4), allowNull: false, defaultValue: 0, field: "cost_ghs" },
    status: { type: DataTypes.STRING(10), allowNull: false, field: "status" },
    errorClass: { type: DataTypes.STRING(20), allowNull: true, field: "error_class" },
    errorMessage: { type: DataTypes.STRING(300), allowNull: true, field: "error_message" },
    latencyMs: { type: DataTypes.INTEGER, allowNull: true, field: "latency_ms" },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: "created_at" },
  },
  { sequelize, tableName: "Ai_usage_log", schema: "dbo", timestamps: false }
);

export default AiUsageLog;
