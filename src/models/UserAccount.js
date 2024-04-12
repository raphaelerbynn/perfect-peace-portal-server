import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";


const _ = sequelize.define('userAccount', {
    username: {
      type: DataTypes.STRING(50),
      allowNull: false,
      primaryKey: true
    },
    name: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    email: {
      type: DataTypes.STRING(80),
      allowNull: true
    },
    category: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    password: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    teacherId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'Teacher',
        key: 'teacher_id'
      },
      field: 'teacherId'
    }
  }, {
    sequelize,
    tableName: 'User_account',
    schema: 'dbo',
    timestamps: false,
    indexes: [
      {
        name: "PK__User_acc__F3DBC5737B0A1D14",
        unique: true,
        fields: [
          { name: "username" },
        ]
      },
    ]
  });

  // _.sync()

export default _