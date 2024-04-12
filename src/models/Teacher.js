import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";


const _ = sequelize.define('teacher', {
    teacherId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      autoIncrement: true,
      field: 'teacher_id'
    },
    fName: {
      type: DataTypes.STRING(20),
      allowNull: false,
      field: 'f_name'
    },
    lName: {
      type: DataTypes.STRING(20),
      allowNull: false,
      field: 'l_name'
    },
    password: {
      type: DataTypes.STRING,
      allowNull: true
    },
    gender: {
      type: DataTypes.STRING(10),
      allowNull: false
    },
    phone: {
      type: DataTypes.STRING(14),
      allowNull: true
    },
    email: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    address: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    classId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'class_id'
    },
    category: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    staffPosition: {
      type: DataTypes.STRING(100),
      allowNull: true,
      field: 'staff_position'
    },
    ssnitNumber: {
      type: DataTypes.STRING(100),
      allowNull: true,
      field: 'ssnit_number'
    },
    tinNumber: {
      type: DataTypes.STRING(100),
      allowNull: true,
      field: 'tin_number'
    },
    bank: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    accountNumber: {
      type: DataTypes.STRING(100),
      allowNull: true,
      field: 'account_number'
    },
    dateUpdated: {
      type: DataTypes.DATEONLY,
      allowNull: true,
      field: 'date_updated'
    },
    dateRegistered: {
      type: DataTypes.DATEONLY,
      allowNull: true,
      field: 'date_registered'
    }
  }, {
    sequelize,
    tableName: 'Teacher',
    schema: 'dbo',
    timestamps: false,
    indexes: [
      {
        name: "PK__tmp_ms_x__03AE777E7DE46B82",
        unique: true,
        fields: [
          { name: "teacher_id" },
        ]
      },
    ]
  });


export default _