import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

// AI-5 (migration 046): when the briefing is made and where it goes, one row
// (id 1). days = ISO weekdays [1..7] (1 = Monday); runTime "HH:MM" in
// Africa/Accra. emailTo / whatsappTo go to those providers only, never to the AI.
const AiBriefingSettings = sequelize.define(
  "aiBriefingSettings",
  {
    briefingSettingsId: { type: DataTypes.INTEGER, allowNull: false, primaryKey: true, defaultValue: 1, field: "briefing_settings_id" },
    days: { type: DataTypes.JSONB, allowNull: false, defaultValue: [1], field: "days" },
    runTime: { type: DataTypes.STRING(5), allowNull: false, defaultValue: "06:00", field: "run_time" },
    owingThresholdGhs: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 100, field: "owing_threshold_ghs" },
    emailEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: "email_enabled" },
    emailTo: { type: DataTypes.STRING(254), allowNull: true, field: "email_to" },
    whatsappEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: "whatsapp_enabled" },
    whatsappTo: { type: DataTypes.STRING(20), allowNull: true, field: "whatsapp_to" },
    updatedBy: { type: DataTypes.STRING(100), allowNull: true, field: "updated_by" },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: "updated_at" },
  },
  { sequelize, tableName: "Ai_briefing_settings", schema: "dbo", timestamps: false }
);

export default AiBriefingSettings;
