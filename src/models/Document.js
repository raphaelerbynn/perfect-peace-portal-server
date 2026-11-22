import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

// B17: a file kept on a pupil's or staff member's record (migration 033).
// storageKey is internal: it is never sent to the browser.
const Document = sequelize.define(
  "document",
  {
    documentId: { autoIncrement: true, type: DataTypes.INTEGER, allowNull: false, primaryKey: true, field: "document_id" },
    ownerType: { type: DataTypes.STRING(10), allowNull: false, field: "owner_type" },
    ownerId: { type: DataTypes.INTEGER, allowNull: false, field: "owner_id" },
    docType: { type: DataTypes.STRING(40), allowNull: false, field: "doc_type" },
    title: { type: DataTypes.STRING(100), allowNull: false, field: "title" },
    storageKey: { type: DataTypes.STRING(120), allowNull: false, unique: true, field: "storage_key" },
    mime: { type: DataTypes.STRING(60), allowNull: false, field: "mime" },
    sizeBytes: { type: DataTypes.INTEGER, allowNull: false, field: "size_bytes" },
    originalName: { type: DataTypes.STRING(120), allowNull: true, field: "original_name" },
    uploadedBy: { type: DataTypes.STRING(100), allowNull: true, field: "uploaded_by" },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: "created_at" },
  },
  {
    sequelize,
    tableName: "Document",
    schema: "dbo",
    timestamps: false,
    indexes: [{ name: "idx_document_owner", fields: ["owner_type", "owner_id"] }],
  }
);

export default Document;
