import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

// Unified, secure store for short-lived password-reset codes used by BOTH
// reset flows (admin-portal OTP + parent-app PIN). The plaintext code is NEVER
// persisted — only its bcrypt hash. Expiry, attempt-capping and single-use are
// all enforced server-side on read (see services/resetCode.js). There is no
// import-time `.sync()` (Feature #1 removed those); create the table with the
// migration documented in the task report.
const _ = sequelize.define(
  "passwordResetCode",
  {
    id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      autoIncrement: true,
      field: "id",
    },
    // Identifier of the account the code was issued for. For students/teachers
    // this is the numeric index id; for management it is the staff/teacher id.
    identifier: {
      type: DataTypes.STRING(50),
      allowNull: false,
      field: "identifier",
    },
    // Discriminator so the same identifier value cannot collide across flows
    // (e.g. "STU", "STAFF", "MANAGEMENT").
    userType: {
      type: DataTypes.STRING(20),
      allowNull: false,
      field: "user_type",
    },
    // bcrypt hash of the 6-digit code. Never the plaintext.
    codeHash: {
      type: DataTypes.STRING(255),
      allowNull: false,
      field: "code_hash",
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: false,
      field: "expires_at",
    },
    attempts: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      field: "attempts",
    },
    consumed: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      field: "consumed",
    },
  },
  {
    sequelize,
    tableName: "Password_reset_code",
    schema: "dbo",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: "updated_at",
    indexes: [
      {
        name: "IDX_password_reset_identifier_type",
        fields: [{ name: "identifier" }, { name: "user_type" }],
      },
    ],
  }
);

export default _;
