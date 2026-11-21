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
    },
    // B13 (migration 023). receipt_no is filled by the database (sequence
    // default) — never set it from the app. allowNull here only so the data
    // move can load old rows before 002 numbers them.
    receiptNo: {
      type: DataTypes.STRING(30),
      allowNull: true,
      field: 'receipt_no'
    },
    recordedBy: {
      type: DataTypes.STRING(100),
      allowNull: true,
      field: 'recorded_by'
    },
    recordedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: 'recorded_at'
    },
    reversedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: 'reversed_at'
    },
    reversedBy: {
      type: DataTypes.STRING(100),
      allowNull: true,
      field: 'reversed_by'
    },
    reversalReason: {
      type: DataTypes.STRING(500),
      allowNull: true,
      field: 'reversal_reason'
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