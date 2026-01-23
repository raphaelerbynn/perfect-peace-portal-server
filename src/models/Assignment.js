import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

const assignment = sequelize.define('assignment', {
    assignmentId: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      field: 'assignment_id'
    },
    fileData: {
      type: DataTypes.STRING,
      allowNull: true
    },
    class: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    subject: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    submissionDate: {
      type: DataTypes.STRING(100),
      allowNull: true,
      field: 'submission_date'
    },
    teacherId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'teacher_id'
    },
    fileName: {
      type: DataTypes.STRING(100),
      allowNull: true,
      field: 'file_name'
    }
  }, {
    sequelize,
    tableName: 'Assignment',
    schema: 'dbo',
    timestamps: false,
    indexes: [
      {
        name: "PK__tmp_ms_x__DA89181465FA60DA",
        unique: true,
        fields: [
          { name: "assignment_id" },
        ]
      },
    ]
  });

export default assignment
