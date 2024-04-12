import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";


const _ = sequelize.define('extraClasses', {
    extraClassesId: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      field: 'extra_classes_id'
    },
    teacher: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    class: {
      type: DataTypes.STRING(10),
      allowNull: true
    },
    amount: {
      type: DataTypes.DECIMAL(18,0),
      allowNull: true
    },
    date: {
      type: DataTypes.DATEONLY,
      allowNull: true
    }
  }, {
    sequelize,
    tableName: 'Extra_classes',
    schema: 'dbo',
    timestamps: false,
    indexes: [
      {
        name: "PK__Extra_cl__AACC875D1AED251D",
        unique: true,
        fields: [
          { name: "extra_classes_id" },
        ]
      },
    ]
  });


export default _