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
      type: DataTypes.STRING(50),
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
      type: DataTypes.DECIMAL(18, 2),
      allowNull: true,
      defaultValue: 0, // migration 022: never NULL in the data
      field: 'fees_paid'
    },
    feesOwing: {
      type: DataTypes.DECIMAL(18, 2),
      allowNull: true,
      defaultValue: 0, // migration 022: never NULL in the data
      field: 'fees_owing'
    },
    // Fee period (db/migrations/008_fee_periods.sql, services/fee.js).
    feesOpeningBalance: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0, field: 'fees_opening_balance' },
    feesBillAtStart: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0, field: 'fees_bill_at_start' },
    feesPaidAtStart: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0, field: 'fees_paid_at_start' },
    feesPeriodAfterFeeId: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'fees_period_after_fee_id' },
    feesPeriodStartedAt: { type: DataTypes.DATE, allowNull: true, field: 'fees_period_started_at' },
    // Migration 030 (B12): the term the current fee period bills for (null = a
    // period promotion started, waiting for the next term to be billed).
    feesPeriodTermId: { type: DataTypes.INTEGER, allowNull: true, field: 'fees_period_term_id' },
    // B18: admission number (migration 035). New pupils get one from the
    // school's format; existing pupils keep NULL (they sign in with STU/<id>).
    admissionNo: { type: DataTypes.STRING(30), allowNull: true, field: 'admission_no' },
    // B17: current photo (storage key, migration 033). Never sent as a URL:
    // the API streams it to users allowed to see the pupil.
    photoKey: { type: DataTypes.STRING(120), allowNull: true, field: 'photo_key' },
    // BE-S4/BE-S5: soft delete. The underlying `is_deleted` column is added by a
    // manual DB migration (see report). Archived students are excluded from every
    // read; deleteStudent flips this flag instead of destroying rows.
    isDeleted: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      field: 'is_deleted'
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