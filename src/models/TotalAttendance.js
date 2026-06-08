import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";


const _ = sequelize.define('totalAttendance', {
    totalAttendanceId: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      field: 'total_attendance_id'
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
    present: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    sick: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    attendance: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    termId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'Term',
        key: 'term_id'
      },
      field: 'term_id'
    }
  }, {
    sequelize,
    tableName: 'Total_attendance',
    schema: 'dbo',
    timestamps: false,
    // NOTE: the underlying unique index is created by a separate manual migration;
    // this array is documentation only (model .sync() is disabled).
    indexes: [
      {
        // BE-3: backs the idempotent term roll-up upsert (one row per student per term).
        name: "uniq_total_attendance",
        unique: true,
        fields: [{ name: "student_id" }, { name: "term_id" }],
      },
    ]
  });

  // _.sync()

  


export default _