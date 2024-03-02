import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";


const _ = sequelize.define('studentResult', {
    studentResultId: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      field: 'student_result_id'
    },
    studentId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'Student',
        key: 'student_id'
      },
      field: 'student_id'
    },
    rawScore: {
      type: DataTypes.DECIMAL(18,0),
      allowNull: true,
      field: 'raw_score'
    },
    passRawScore: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'pass_raw_score'
    },
    totalRawScore: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'total_raw_score'
    },
    classTotal: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'class_total'
    },
    resultStatus: {
      type: DataTypes.STRING(50),
      allowNull: true,
      field: 'result_status'
    },
    promotedTo: {
      type: DataTypes.STRING(50),
      allowNull: true,
      field: 'promoted_to'
    },
    class: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    term: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    conduct: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    attitude: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    interest: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    teacherRemarks: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: 'teacher_remarks'
    },
    date: {
      type: DataTypes.DATEONLY,
      allowNull: true
    }
  }, {
    sequelize,
    tableName: 'Student_result',
    schema: 'dbo',
    timestamps: false,
    indexes: [
      {
        name: "PK_Student_result",
        unique: true,
        fields: [
          { name: "student_result_id" },
        ]
      },
    ]
  });

  


export default _