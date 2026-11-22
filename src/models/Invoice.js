import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

// B14 (migration 042): a numbered copy of a pupil's bill for one term.
// paid / credited / balance / status are kept up to date by
// services/invoiceLedger.js (called from recomputeStudentOwing).
// An invoice never changes what a pupil owes.
const Invoice = sequelize.define(
  "invoice",
  {
    invoiceId: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, field: "invoice_id" },
    invoiceNo: { type: DataTypes.STRING(30), allowNull: true, field: "invoice_no" }, // set on issue
    studentId: { type: DataTypes.INTEGER, allowNull: false, field: "student_id" },
    termId: { type: DataTypes.INTEGER, allowNull: false, field: "term_id" },
    classId: { type: DataTypes.INTEGER, allowNull: true, field: "class_id" },
    // DRAFT | ISSUED | PARTIALLY_PAID | PAID | CARRIED_FORWARD | VOID
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "DRAFT", field: "status" },
    afterFeeId: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: "after_fee_id" },
    arrears: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0, field: "arrears" },
    subtotal: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0, field: "subtotal" },
    discount: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0, field: "discount" },
    total: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0, field: "total" },
    amountPaid: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0, field: "amount_paid" },
    amountCredited: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0, field: "amount_credited" },
    adjustment: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0, field: "adjustment" },
    balance: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0, field: "balance" },
    dueDate: { type: DataTypes.DATEONLY, allowNull: true, field: "due_date" },
    notes: { type: DataTypes.STRING(500), allowNull: true, field: "notes" },
    createdBy: { type: DataTypes.STRING(100), allowNull: true, field: "created_by" },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: "created_at" },
    refreshedAt: { type: DataTypes.DATE, allowNull: true, field: "refreshed_at" },
    issuedBy: { type: DataTypes.STRING(100), allowNull: true, field: "issued_by" },
    issuedAt: { type: DataTypes.DATE, allowNull: true, field: "issued_at" },
    voidedBy: { type: DataTypes.STRING(100), allowNull: true, field: "voided_by" },
    voidedAt: { type: DataTypes.DATE, allowNull: true, field: "voided_at" },
    voidReason: { type: DataTypes.STRING(500), allowNull: true, field: "void_reason" },
  },
  { sequelize, tableName: "Invoice", schema: "dbo", timestamps: false }
);

export default Invoice;
