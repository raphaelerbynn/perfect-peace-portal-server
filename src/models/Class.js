import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";


const _class = sequelize.define('class_', {
    classId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      autoIncrement: true,
      field: 'class_id'
    },
    name: {
      type: DataTypes.STRING(50),
      allowNull: false
    },
    section: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    teacherId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'teacher_id'
    },
    capacity: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    tuition: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    firstAid: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    pta: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'PTA'
    },
    water: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    maintenance: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    stationary: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    cocurricular: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    fees: {
      type: DataTypes.INTEGER,
      allowNull: true
    }
  }, {
    sequelize,
    tableName: 'Class',
    schema: 'dbo',
    timestamps: false,
    indexes: [
      {
        name: "PK__Class__FDF47986D46C5C76",
        unique: true,
        fields: [
          { name: "class_id" },
        ]
      },
    ]
  });

export default _class
