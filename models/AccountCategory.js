import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";


const _ = sequelize.define('accountCategory', {
    accountCategoryId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      autoIncrement: true,
      field: 'account_category_id'
    },
    name: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    type: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
  }, {
    sequelize,
    tableName: 'AccountCategory',
    schema: 'dbo',
    timestamps: false,
    indexes: [
      {
        name: "PK__Account_Category__404B6A6BD85DA608",
        unique: true,
        fields: [
          { name: "account_category_id" },
        ]
      },
    ]
  });

  // _.sync()

export default _
