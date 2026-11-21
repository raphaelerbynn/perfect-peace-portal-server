import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

// B5: pass mark for promotion. classId null = the school default.
const PromotionRule = sequelize.define(
  "promotionRule",
  {
    promotionRuleId: { autoIncrement: true, type: DataTypes.INTEGER, allowNull: false, primaryKey: true, field: "promotion_rule_id" },
    classId: { type: DataTypes.INTEGER, allowNull: true, field: "class_id" },
    passMark: { type: DataTypes.DECIMAL(5, 2), allowNull: false, field: "pass_mark" },
    updatedBy: { type: DataTypes.STRING(100), allowNull: true, field: "updated_by" },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: "updated_at" },
  },
  { sequelize, tableName: "Promotion_rule", schema: "dbo", timestamps: false }
);

export default PromotionRule;
