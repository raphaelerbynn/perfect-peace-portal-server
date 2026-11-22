import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

// B18: the last running admission number used per scope (migration 035).
// Read and written with raw SQL under a row lock (services/admission.js); the
// model exists so devSync and the data move create the table. updated_at uses
// now() (not DataTypes.NOW) so a table made by sync gets a database default.
const AdmissionCounter = sequelize.define(
  "admissionCounter",
  {
    scope: { type: DataTypes.STRING(60), allowNull: false, primaryKey: true, field: "scope" },
    lastValue: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: "last_value" },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.fn("now"), field: "updated_at" },
  },
  { sequelize, tableName: "Admission_counter", schema: "dbo", timestamps: false }
);

export default AdmissionCounter;
