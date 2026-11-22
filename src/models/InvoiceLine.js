import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

// B14 (migration 042): one line of an invoice. kind ARREARS (brought forward,
// below 0 = credit) | ITEM (a fee item) | DISCOUNT (below 0).
const InvoiceLine = sequelize.define(
  "invoiceLine",
  {
    invoiceLineId: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, field: "invoice_line_id" },
    invoiceId: { type: DataTypes.INTEGER, allowNull: false, field: "invoice_id" },
    position: { type: DataTypes.INTEGER, allowNull: false, field: "position" },
    kind: { type: DataTypes.STRING(10), allowNull: false, field: "kind" },
    description: { type: DataTypes.STRING(200), allowNull: false, field: "description" },
    amount: { type: DataTypes.DECIMAL(18, 2), allowNull: false, field: "amount" },
  },
  { sequelize, tableName: "Invoice_line", schema: "dbo", timestamps: false }
);

export default InvoiceLine;
