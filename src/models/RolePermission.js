import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

// B10 (migration 050): one permission a CUSTOM role holds. permission_key is a
// key of the catalogue in utils/permissions.js (unknown keys are ignored when
// read, refused when written). System roles have no rows: their sets are code.
const RolePermission = sequelize.define(
  "rolePermission",
  {
    roleId: { type: DataTypes.INTEGER, primaryKey: true, allowNull: false, field: "role_id" },
    permissionKey: { type: DataTypes.STRING(60), primaryKey: true, allowNull: false, field: "permission_key" },
  },
  {
    sequelize,
    tableName: "Role_permission",
    schema: "dbo",
    timestamps: false,
  }
);

export default RolePermission;
