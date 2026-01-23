import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";


const _ = sequelize.define('parent', {
    parentId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      autoIncrement: true,
      field: 'parent_id'
    },
    fName: {
      type: DataTypes.STRING(20),
      allowNull: false,
      field: 'f_name'
    },
    lName: {
      type: DataTypes.STRING(20),
      allowNull: false,
      field: 'l_name'
    },
    gender: {
      type: DataTypes.STRING(10),
      allowNull: true
    },
    contact: {
      type: DataTypes.STRING(14),
      allowNull: false
    },
    contact1: {
      type: DataTypes.STRING(14),
      allowNull: true
    },
    relationship: {
      type: DataTypes.STRING(20),
      allowNull: true
    },
    email: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    occupation: {
      type: DataTypes.STRING(100),
      allowNull: true
    }
  }, {
    sequelize,
    tableName: 'Parent',
    schema: 'dbo',
    timestamps: false,
    indexes: [
      {
        name: "PK_Parent",
        unique: true,
        fields: [
          { name: "parent_id" },
        ]
      },
    ]
  });


export default _