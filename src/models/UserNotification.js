import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

// B16 (migration 040): one in-app notification for one recipient.
// recipientType STUDENT | STAFF | OFFICE; recipientId = studentId, teacherId or
// the office username (stored as text). readAt null = unread.
const UserNotification = sequelize.define(
  "userNotification",
  {
    notificationId: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, field: "notification_id" },
    recipientType: { type: DataTypes.STRING(10), allowNull: false, field: "recipient_type" },
    recipientId: { type: DataTypes.STRING(100), allowNull: false, field: "recipient_id" },
    type: { type: DataTypes.STRING(30), allowNull: false, field: "type" },
    title: { type: DataTypes.STRING(200), allowNull: false, field: "title" },
    body: { type: DataTypes.TEXT, allowNull: true, field: "body" },
    linkUrl: { type: DataTypes.STRING(300), allowNull: true, field: "link_url" },
    entityType: { type: DataTypes.STRING(30), allowNull: true, field: "entity_type" },
    entityId: { type: DataTypes.STRING(60), allowNull: true, field: "entity_id" },
    readAt: { type: DataTypes.DATE, allowNull: true, field: "read_at" },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: "created_at" },
  },
  {
    sequelize,
    tableName: "User_notification",
    schema: "dbo",
    timestamps: false,
    indexes: [
      { name: "idx_user_notification_unread", fields: ["recipient_type", "recipient_id", "read_at"] },
      { name: "idx_user_notification_entity", fields: ["type", "entity_type", "entity_id"] },
    ],
  }
);

export default UserNotification;
