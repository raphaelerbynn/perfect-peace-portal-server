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
    attendance: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    termEndDate: {
      type: DataTypes.DATEONLY,
      allowNull: true,
      field: 'term_end_date'
    }
  }, {
    sequelize,
    tableName: 'Total_attendance',
    schema: 'dbo',
    timestamps: false,
    indexes: [
      {
        name: "PK__Total_at__466DB354A15DBA2B",
        unique: true,
        fields: [
          { name: "total_attendance_id" },
        ]
      },
    ]
  });

  


export default _