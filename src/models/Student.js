import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";


const _ = sequelize.define('student', {
    studentId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      autoIncrement: true,
      field: 'student_id'
    },
    password: {
      type: DataTypes.STRING,
      allowNull: true
    },
    fName: {
      type: DataTypes.STRING(20),
      allowNull: false,
      field: 'f_name'
    },
    mName: {
      type: DataTypes.STRING(20),
      allowNull: true,
      field: 'm_name'
    },
    lName: {
      type: DataTypes.STRING(20),
      allowNull: false,
      field: 'l_name'
    },
    dob: {
      type: DataTypes.DATEONLY,
      allowNull: false
    },
    age: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    gender: {
      type: DataTypes.STRING(10),
      allowNull: true
    },
    address: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    class: {
      type: DataTypes.STRING(20),
      allowNull: true
    },
    dateRegistered: {
      type: DataTypes.DATEONLY,
      allowNull: true,
      field: 'date_registered'
    },
    dateUpdated: {
      type: DataTypes.DATEONLY,
      allowNull: true,
      field: 'date_updated'
    },
    parentId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'parent_id'
    },
    classId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'class_id'
    },
    feesPaid: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'fees_paid'
    },
    feesOwing: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'fees_owing'
    }
  }, {
    sequelize,
    tableName: 'Student',
    schema: 'dbo',
    timestamps: false,
    indexes: [
      {
        name: "PK__tmp_ms_x__2A33069AAB5BDDDC",
        unique: true,
        fields: [
          { name: "student_id" },
        ]
      },
    ]
  });


export default _