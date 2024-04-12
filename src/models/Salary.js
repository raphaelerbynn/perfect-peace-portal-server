import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

const _ = sequelize.define('salary', {
    salaryId: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      field: 'salary_id'
    },
    title: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    rank: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    amount: {
      type: DataTypes.DECIMAL(18,0),
      allowNull: true
    }
  }, {
    sequelize,
    tableName: 'Salary',
    schema: 'dbo',
    timestamps: false,
    indexes: [
      {
        name: "PK__Salary__A3C71C513F68B5A0",
        unique: true,
        fields: [
          { name: "salary_id" },
        ]
      },
    ]
  });


export default _