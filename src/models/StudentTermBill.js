import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

// B12 (migration 030): one row per pupil per billed term, a snapshot of what
// the term's bill was (arrears carried in, items, discounts) for statements.
// The balance itself is still the fee period's (services/fee.js).
const StudentTermBill = sequelize.define(
  "studentTermBill",
  {
    studentTermBillId: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, field: "student_term_bill_id" },
    studentId: { type: DataTypes.INTEGER, allowNull: false, field: "student_id" },
    termId: { type: DataTypes.INTEGER, allowNull: false, field: "term_id" },
    classId: { type: DataTypes.INTEGER, allowNull: true, field: "class_id" },
    // NEW = a new period started; ADOPTED = the term took over a period promotion had started
    kind: { type: DataTypes.STRING(10), allowNull: false, field: "kind" },
    arrears: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0, field: "arrears" },
    bill: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0, field: "bill" },
    discount: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0, field: "discount" },
    items: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: "items" },
    discounts: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: "discounts" },
    afterFeeId: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: "after_fee_id" },
    billedBy: { type: DataTypes.STRING(100), allowNull: true, field: "billed_by" },
    billedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: "billed_at" },
  },
  { sequelize, tableName: "Student_term_bill", schema: "dbo", timestamps: false }
);

export default StudentTermBill;
