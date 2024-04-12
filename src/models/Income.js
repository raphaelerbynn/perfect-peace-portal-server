import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";


const _ = sequelize.define('income', {
    incomeId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      autoIncrement: true,
      field: 'income_id'
    },
    income: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    amount: {
      type: DataTypes.DECIMAL(18,0),
      allowNull: true
    },
    accountCategoryId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'AccountCategory',
        key: 'account_category_id'
      },
      field: 'account_category_id'
    },
    date: {
      type: DataTypes.DATEONLY,
      allowNull: true
    }
  }, {
    sequelize,
    tableName: 'Income',
    schema: 'dbo',
    timestamps: false,
    indexes: [
      {
        name: "PK__Income__404B6A6BD85DA608",
        unique: true,
        fields: [
          { name: "income_id" },
        ]
      },
    ]
  });

  // _.sync()

export default _
