import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";


const _ = sequelize.define('kgCalcValues', {
    kgCalcValueId: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      field: 'kg_calc_value_id'
    },
    examTotal: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'exam_total'
    },
    examPercentage: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'exam_percentage'
    },
    classTotal: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'class_total'
    },
    classPercentage: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'class_percentage'
    }
  }, {
    sequelize,
    tableName: 'KG_calc_values',
    schema: 'dbo',
    timestamps: false,
    indexes: [
      {
        name: "PK__KG_calc___B15F030B0553DAF5",
        unique: true,
        fields: [
          { name: "kg_calc_value_id" },
        ]
      },
    ]
  });


export default _