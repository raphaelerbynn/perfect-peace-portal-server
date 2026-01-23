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
      },
      field: 'term_id'
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
    indexes: [
      {
        name: "PK__Attendan__20D6A9680BD85DFC",
        unique: true,
        fields: [
          { name: "attendance_id" },
        ]
      },
    ]
  });

  // attendance.sync()
  

export default attendance
