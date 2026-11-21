import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

// B16 (migration 040): one email tried. status SENT | LOGGED (EMAIL_DRIVER=log,
// nothing sent) | FAILED (error = a short reason, never credentials).
const EmailLog = sequelize.define(
  "emailLog",
  {
    emailId: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, field: "email_id" },
    notificationType: { type: DataTypes.STRING(30), allowNull: true, field: "notification_type" },
    recipientType: { type: DataTypes.STRING(10), allowNull: true, field: "recipient_type" },
    recipientId: { type: DataTypes.STRING(100), allowNull: true, field: "recipient_id" },
    toAddress: { type: DataTypes.STRING(255), allowNull: false, field: "to_address" },
    subject: { type: DataTypes.STRING(200), allowNull: false, field: "subject" },
    status: { type: DataTypes.STRING(10), allowNull: false, field: "status" },
    error: { type: DataTypes.STRING(300), allowNull: true, field: "error" },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: "created_at" },
  },
  { sequelize, tableName: "Email_log", schema: "dbo", timestamps: false }
);

export default EmailLog;
