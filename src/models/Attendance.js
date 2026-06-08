import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";


const attendance = sequelize.define('attendance', {
    attendanceId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      autoIncrement: true,
      field: 'attendance_id'
    },
    class: {
      type: DataTypes.STRING(10),
      allowNull: true
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
    termId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'term_id',
      references: {
        model: 'Term',
        key: 'term_id'
      }
    },
    status: {
      type: DataTypes.CHAR(10),
      allowNull: true
    },
    dateMarked: {
      type: DataTypes.DATEONLY,
      allowNull: true,
      field: 'date_marked'
    },
    dateEnd: {
      type: DataTypes.DATEONLY,
      allowNull: true,
      field: 'date_end'
    }
  }, {
    sequelize,
    tableName: 'Attendance',
    schema: 'dbo',
    timestamps: false,
    // NOTE: the underlying unique index is created by a separate manual migration;
    // this array is documentation only (model .sync() is disabled).
    indexes: [
      {
        // BE-4: backs the non-destructive upsert — one mark per student per day per term.
        name: "uniq_attendance",
        unique: true,
        fields: [{ name: "student_id" }, { name: "date_marked" }, { name: "term_id" }],
      },
    ]
  });

  // attendance.sync()
  

export default attendance
