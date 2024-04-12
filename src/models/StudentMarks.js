import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";


const _ = sequelize.define('studentMarks', {
    studentMarksId: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      field: 'student_marks_id'
    },
    subjectId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'Subject',
        key: 'subject_id'
      },
      field: 'subject_id'
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
    examScore: {
      type: DataTypes.DECIMAL(18,0),
      allowNull: true,
      field: 'exam_score'
    },
    examScorePercentage: {
      type: DataTypes.DECIMAL(18,0),
      allowNull: true,
      field: 'exam_score_percentage'
    },
    classScore: {
      type: DataTypes.DECIMAL(18,0),
      allowNull: true,
      field: 'class_score'
    },
    classScorePercentage: {
      type: DataTypes.DECIMAL(18,0),
      allowNull: true,
      field: 'class_score_percentage'
    },
    totalScore: {
      type: DataTypes.DECIMAL(18,0),
      allowNull: true,
      field: 'total_score'
    },
    class: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    remarks: {
      type: DataTypes.STRING(10),
      allowNull: true
    },
    term: {
      type: DataTypes.STRING(10),
      allowNull: true
    },
    date: {
      type: DataTypes.DATEONLY,
      allowNull: true
    }
  }, {
    sequelize,
    tableName: 'Student_marks',
    schema: 'dbo',
    timestamps: false,
    indexes: [
      {
        name: "PK__Student___D06A6528FFE156D5",
        unique: true,
        fields: [
          { name: "student_marks_id" },
        ]
      },
    ]
  });


export default _