import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

// B18: school identity and branding, one row (id 1). Migration 034.
const SchoolSettings = sequelize.define(
  "schoolSettings",
  {
    schoolSettingsId: { type: DataTypes.INTEGER, allowNull: false, primaryKey: true, defaultValue: 1, field: "school_settings_id" },
    name: { type: DataTypes.STRING(100), allowNull: false, field: "name" },
    shortName: { type: DataTypes.STRING(40), allowNull: true, field: "short_name" },
    motto: { type: DataTypes.STRING(150), allowNull: true, field: "motto" },
    addressLines: { type: DataTypes.STRING(300), allowNull: true, field: "address_lines" },
    email: { type: DataTypes.STRING(100), allowNull: true, field: "email" },
    phones: { type: DataTypes.STRING(80), allowNull: true, field: "phones" },
    logoKey: { type: DataTypes.STRING(120), allowNull: true, field: "logo_key" },
    primaryColor: { type: DataTypes.STRING(7), allowNull: true, field: "primary_color" },
    accentColor: { type: DataTypes.STRING(7), allowNull: true, field: "accent_color" },
    admissionFormat: { type: DataTypes.STRING(40), allowNull: true, field: "admission_format" },
    reportCardFooter: { type: DataTypes.STRING(300), allowNull: true, field: "report_card_footer" },
    receiptFooter: { type: DataTypes.STRING(300), allowNull: true, field: "receipt_footer" },
    updatedBy: { type: DataTypes.STRING(100), allowNull: true, field: "updated_by" },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: "updated_at" },
  },
  { sequelize, tableName: "School_settings", schema: "dbo", timestamps: false }
);

export default SchoolSettings;
