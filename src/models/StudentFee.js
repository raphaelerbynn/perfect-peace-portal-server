import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

const studentFee = sequelize.define(
  "studentFee",
  {
    studentFeeId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      autoIncrement: true,
      field: "student_fee_id",
    },
    name: {
      type: DataTypes.STRING(50),
      allowNull: false,
    },
    studentId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: "student_id",
    },
    amount: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: "StudentFee",
    timestamps: false,
  }
);

// NOTE: import-time `studentFee.sync()` removed (BE-8). Issuing DDL on every
// boot is unsafe in production. Use the explicit `src/scripts/syncStudentFee.js`
// script when the schema actually needs to be (re)created.

export default studentFee;
