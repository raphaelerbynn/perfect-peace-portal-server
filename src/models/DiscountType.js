import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

// B12 (migration 031): a named fee discount.
const DiscountType = sequelize.define(
  "discountType",
  {
    discountTypeId: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, field: "discount_type_id" },
    name: { type: DataTypes.STRING(100), allowNull: false, field: "name" },
    description: { type: DataTypes.STRING(500), allowNull: true, field: "description" },
    // PERCENT (0-100) | FIXED (GH₵)
    kind: { type: DataTypes.STRING(10), allowNull: false, field: "kind" },
    value: { type: DataTypes.DECIMAL(18, 2), allowNull: false, field: "value" },
    // null = every fee item; otherwise only items with this name (e.g. "Tuition")
    appliesTo: { type: DataTypes.STRING(50), allowNull: true, field: "applies_to" },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: "is_active" },
    createdBy: { type: DataTypes.STRING(100), allowNull: true, field: "created_by" },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: "created_at" },
  },
  { sequelize, tableName: "Discount_type", schema: "dbo", timestamps: false }
);

export default DiscountType;
