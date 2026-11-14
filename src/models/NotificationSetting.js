import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

// B16 (migration 040): the office's switches per notification type.
const NotificationSetting = sequelize.define(
  "notificationSetting",
  {
    type: { type: DataTypes.STRING(30), primaryKey: true, allowNull: false, field: "type" },
    inApp: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: "in_app" },
    email: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: "email" },
    updatedBy: { type: DataTypes.STRING(100), allowNull: true, field: "updated_by" },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: "updated_at" },
  },
  { sequelize, tableName: "Notification_setting", schema: "dbo", timestamps: false }
);

export default NotificationSetting;
