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
      type: DataTypes.DECIMAL(18, 2),
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: "StudentFee",
    // Every other table lives in "dbo"; without this the table was created in
    // "public" and the data move (which loads into dbo) could not find it.
    schema: "dbo",
    timestamps: false,
  }
);

// NOTE: import-time `studentFee.sync()` removed (BE-8). Issuing DDL on every
// boot is unsafe in production. Use the explicit `src/scripts/syncStudentFee.js`
// script when the schema actually needs to be (re)created.

export default studentFee;
