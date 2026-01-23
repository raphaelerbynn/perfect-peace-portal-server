import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";


const employeeSalary = sequelize.define('employeeSalary', {
    employeeSalaryId: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      field: 'employee_salary_id'
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
    salaryId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'Salary',
        key: 'salary_id'
      },
      field: 'salaryId'
    }
  }, {
    sequelize,
    tableName: 'Employee_salary',
    schema: 'dbo',
    timestamps: false,
    indexes: [
      {
        name: "PK__Employee__E0C5E81D40C0D657",
        unique: true,
        fields: [
          { name: "employee_salary_id" },
        ]
      },
    ]
  });

export default employeeSalary