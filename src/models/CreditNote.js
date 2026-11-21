import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

// B14 (migration 042): money taken off what a pupil owes, against their
// current invoice. Counts in the fee-period formula (services/fee.js) while
// the period it was made in (termId + periodAfterFeeId) is the pupil's current
// one. creditNoteNo is assigned by the database (CN-<year>-00001). Voided,
// never deleted.
const CreditNote = sequelize.define(
  "creditNote",
  {
    creditNoteId: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, field: "credit_note_id" },
    creditNoteNo: { type: DataTypes.STRING(30), allowNull: true, field: "credit_note_no" },
    invoiceId: { type: DataTypes.INTEGER, allowNull: false, field: "invoice_id" },
    studentId: { type: DataTypes.INTEGER, allowNull: false, field: "student_id" },
    termId: { type: DataTypes.INTEGER, allowNull: false, field: "term_id" },
    periodAfterFeeId: { type: DataTypes.INTEGER, allowNull: false, field: "period_after_fee_id" },
    amount: { type: DataTypes.DECIMAL(18, 2), allowNull: false, field: "amount" },
    reason: { type: DataTypes.STRING(500), allowNull: false, field: "reason" },
    createdBy: { type: DataTypes.STRING(100), allowNull: true, field: "created_by" },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: "created_at" },
    voidedBy: { type: DataTypes.STRING(100), allowNull: true, field: "voided_by" },
    voidedAt: { type: DataTypes.DATE, allowNull: true, field: "voided_at" },
    voidReason: { type: DataTypes.STRING(500), allowNull: true, field: "void_reason" },
    requestId: { type: DataTypes.STRING(64), allowNull: true, field: "request_id" },
  },
  { sequelize, tableName: "Credit_note", schema: "dbo", timestamps: false }
);

export default CreditNote;
