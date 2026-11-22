import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

// B10 (migration 050): an office login role. The three system roles
// (ids 1-3: Administrator, Class Teacher, Accountant) are read-only and their
// permissions are fixed in code (utils/permissions.js SYSTEM_ROLES); a custom
// role's permissions are its Role_permission rows. Names are unique ignoring
// case and outer spaces (index role_name_ci_uq).
const Role = sequelize.define(
  "role",
  {
    roleId: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, field: "role_id" },
    name: { type: DataTypes.STRING(50), allowNull: false, field: "name" },
    description: { type: DataTypes.STRING(200), allowNull: true, field: "description" },
    isSystem: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: "is_system" },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: "created_at" },
    createdBy: { type: DataTypes.STRING(50), allowNull: true, field: "created_by" },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: "updated_at" },
    updatedBy: { type: DataTypes.STRING(50), allowNull: true, field: "updated_by" },
  },
  {
    sequelize,
    tableName: "Role",
    schema: "dbo",
    timestamps: false,
  }
);

export default Role;
