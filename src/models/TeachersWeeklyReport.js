import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";


const _ = sequelize.define('teachersWeeklyReport', {
    weeklyReportId: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      field: 'weekly_report_id'
    },
    teacherId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'Teacher',
        key: 'teacher_id'
      },
      field: 'teacherId'
    },
    class: {
      type: DataTypes.STRING(20),
      allowNull: true
    },
    subject: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    numberExercises: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'number_exercises'
    },
    homeAssignment: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'home_assignment'
    },
    dictation: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    projectWork: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'project_work'
    },
    readingAssignment: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'reading_assignment'
    },
    topicsCovered: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'topics_covered'
    },
    groupWork: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'group_work'
    },
    week: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    date: {
      type: DataTypes.DATEONLY,
      allowNull: true
    }
  }, {
    sequelize,
    tableName: 'Teachers_weekly_report',
    schema: 'dbo',
    timestamps: false,
    indexes: [
      {
        name: "PK_Teachers_weekly_report",
        unique: true,
        fields: [
          { name: "weekly_report_id" },
        ]
      },
    ]
  });


export default _