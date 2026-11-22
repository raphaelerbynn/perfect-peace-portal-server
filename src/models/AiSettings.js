import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

// AI-0 (migration 043): the school's AI switches, one row (id 1).
// featureToggles {ASK: true, ...} (missing key = the app default);
// monthlyCapGhs NULL = AI_MONTHLY_BUDGET_GHS; tone {formal, salutation, britishSpelling}.
const AiSettings = sequelize.define(
  "aiSettings",
  {
    aiSettingsId: { type: DataTypes.INTEGER, allowNull: false, primaryKey: true, defaultValue: 1, field: "ai_settings_id" },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: "enabled" },
    featureToggles: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: "feature_toggles" },
    monthlyCapGhs: { type: DataTypes.DECIMAL(10, 2), allowNull: true, field: "monthly_cap_ghs" },
    tone: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: "tone" },
    updatedBy: { type: DataTypes.STRING(100), allowNull: true, field: "updated_by" },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: "updated_at" },
  },
  { sequelize, tableName: "Ai_settings", schema: "dbo", timestamps: false }
);

export default AiSettings;
