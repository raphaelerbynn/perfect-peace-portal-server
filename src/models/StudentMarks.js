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
      type: DataTypes.DECIMAL(18, 2),
      allowNull: true,
      field: 'exam_score'
    },
    examScorePercentage: {
      type: DataTypes.DECIMAL(18, 2),
      allowNull: true,
      field: 'exam_score_percentage'
    },
    classScore: {
      type: DataTypes.DECIMAL(18, 2),
      allowNull: true,
      field: 'class_score'
    },
    classScorePercentage: {
      type: DataTypes.DECIMAL(18, 2),
      allowNull: true,
      field: 'class_score_percentage'
    },
    totalScore: {
      type: DataTypes.DECIMAL(18, 2),
      allowNull: true,
      field: 'total_score'
    },
    class: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    // B8: the band's remark and grade when the mark was saved (migration 032
    // widened remarks to 50 and added grade), so later scale edits don't
    // change old report cards.
    remarks: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    grade: {
      type: DataTypes.STRING(10),
      allowNull: true
    },
    term: {
      type: DataTypes.STRING(10),
      allowNull: true,
    },
    termId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'Term',
        key: 'term_id'
      },
      field: 'term_id'
    },
    date: {
      type: DataTypes.DATEONLY,
      allowNull: true
    },
    // B2: who entered it (office username or the teacher's name); NULL on old rows.
    enteredBy: {
      type: DataTypes.STRING(100),
      allowNull: true,
      field: 'entered_by'
    },
    enteredByTeacherId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'entered_by_teacher_id'
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

// NOTE: import-time `_.sync()` removed (BE-8). Issuing DDL on every boot is
// unsafe in production. Schema changes are handled by the explicit
// `src/scripts/syncStudentFee.js` script / migrations instead.

export default _