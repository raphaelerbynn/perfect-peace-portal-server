import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

const deductions = sequelize.define('deductions', {
    deductionsId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      autoIncrement: true,
      field: 'deductions_id'
    },
    salaryId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'salary_id'
    },
    title: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    amount: {
      type: DataTypes.DECIMAL(18,0),
      allowNull: true
    }
  }, {
    sequelize,
    tableName: 'Deductions',
    schema: 'dbo',
    timestamps: false,
    indexes: [
      {
        name: "PK__Deductio__54B3E81BFDA26B95",
        unique: true,
        fields: [
          { name: "deductions_id" },
        ]
      },
    ]
  });

  export default deductions;