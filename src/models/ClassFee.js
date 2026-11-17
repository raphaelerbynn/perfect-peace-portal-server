import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

const classFee = sequelize.define(
  "classFee",
  {
    classFeeId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      autoIncrement: true,
      field: "class_fee_id",
    },
    name: {
      type: DataTypes.STRING(50),
      allowNull: false,
    },
    classId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: "class_id",
      references: {
        model: 'Class',
        key: 'class_id'
      },
    },
    amount: {
      type: DataTypes.DECIMAL(18, 2),
      allowNull: true,
    },
    // Migration 048 (B12): TERM = the amount is billed every term (default);
    // YEAR = the amount is for the academic year, each term bills its share
    // (services/classFeeShare.js).
    period: {
      type: DataTypes.STRING(4),
      allowNull: false,
      defaultValue: "TERM",
      field: "period",
    },
    // Migration 048: what the item was billed at for terms already billed
    // ({ "<termId>": { period, amount, yearly, no, of } }), written only for
    // items that are or were YEAR, so a change never re-bills a billed term.
    termAmounts: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: {},
      field: "term_amounts",
    },
  },
  {
    sequelize,
    tableName: "ClassFee",
    schema: "dbo",
    timestamps: false,
  }
);

// classFee.sync()

export default classFee;
