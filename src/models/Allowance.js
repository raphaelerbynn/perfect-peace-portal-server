import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

const allowance = sequelize.define('allowance', {
    allowanceId: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      field: 'allowance_id'
    },
    salaryId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'Salary',
        key: 'salary_id'
      },
      // field: 'salary_id'
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
    tableName: 'Allowance',
    schema: 'dbo',
    timestamps: false,
    indexes: [
      {
        name: "PK__Allowanc__83B187CF4B0C3BB2",
        unique: true,
        fields: [
          { name: "allowance_id" },
        ]
      },
    ]
  });

  // allowance.sync()

export default allowance;
