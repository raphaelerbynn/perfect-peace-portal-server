import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

const _ = sequelize.define('tax', {
    taxId: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      field: 'tax_id'
    },
    name: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    amount: {
      type: DataTypes.DECIMAL(18,0),
      allowNull: true
    },
    salaryId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'Salary',
        key: 'salary_id'
      },
      field: 'salary_id'
    },
  }, {
    sequelize,
    tableName: 'Tax',
    schema: 'dbo',
    timestamps: false,
    indexes: [
      {
        name: "PK__Tax__A3C71C513F68B5A0",
        unique: true,
        fields: [
          { name: "tax_id" },
        ]
      },
    ]
  });

  // _.sync();

export default _