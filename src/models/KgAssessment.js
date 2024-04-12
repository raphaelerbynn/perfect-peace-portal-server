import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";


const _ = sequelize.define('kgAssessment', {
    kgAssessmentId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      autoIncrement: true,
      field: 'kg_assessment_id'
    },
    assessment: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    category: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    satisfactory: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 0
    },
    improved: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 0
    },
    needsImprovement: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 0,
      field: 'needs_improvement'
    },
    unsatisfactory: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 0
    },
    notApplicable: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 0,
      field: 'not_applicable'
    },
    term: {
      type: DataTypes.STRING(10),
      allowNull: true
    },
    class: {
      type: DataTypes.STRING(10),
      allowNull: true
    },
    date: {
      type: DataTypes.DATEONLY,
      allowNull: true
    },
    studentId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'student_id'
    },
    classScore: {
      type: DataTypes.STRING(5),
      allowNull: true,
      field: 'class_score'
    },
    examScore: {
      type: DataTypes.STRING(5),
      allowNull: true,
      field: 'exam_score'
    },
    totalScore: {
      type: DataTypes.STRING(5),
      allowNull: true,
      field: 'total_score'
    },
    promoted: {
      type: DataTypes.STRING(20),
      allowNull: true
    }
  }, {
    sequelize,
    tableName: 'KG_assessment',
    schema: 'dbo',
    timestamps: false,
    indexes: [
      {
        name: "PK__tmp_ms_x__6C22761A4D18A257",
        unique: true,
        fields: [
          { name: "kg_assessment_id" },
        ]
      },
    ]
  });


export default _