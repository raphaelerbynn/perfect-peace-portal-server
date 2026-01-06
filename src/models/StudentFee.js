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

studentFee.sync();

export default studentFee;
