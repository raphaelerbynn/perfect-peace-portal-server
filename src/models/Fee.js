import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";


const _ = sequelize.define('fee', {
    feeId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      autoIncrement: true,
      field: 'fee_id'
    },
    studentId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'student_id'
    },
    classId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'class_id'
    },
    total: {
      type: DataTypes.DECIMAL(18, 2),
      allowNull: true
    },
    paid: {
      type: DataTypes.DECIMAL(18, 2),
      allowNull: true
    },
    remaining: {
      type: DataTypes.DECIMAL(18, 2),
      allowNull: true
    },
    paymentMode: {
      type: DataTypes.STRING(20),
      allowNull: true,
      field: 'payment_mode'
    },
    amountInWords: {
      type: DataTypes.STRING(100),
      allowNull: true,
      field: 'amount_in_words'
    },
    term: {
      type: DataTypes.STRING(5),
      allowNull: true
    },
    // Migration 011: the term this payment counts toward (the open term when
    // it was recorded; old payments matched by number + date).
    termId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'term_id'
    },
    datePaid: {
      type: DataTypes.DATEONLY,
      allowNull: true,
      field: 'date_paid'
    }
  }, {
    sequelize,
    tableName: 'Fee',
    schema: 'dbo',
    timestamps: false,
    indexes: [
      {
        name: "PK__Fee__A19C8AFB2C179D33",
        unique: true,
        fields: [
          { name: "fee_id" },
        ]
      },
    ]
  });


export default _