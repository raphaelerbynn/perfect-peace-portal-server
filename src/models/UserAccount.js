import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";


const _ = sequelize.define('userAccount', {
    username: {
      type: DataTypes.STRING(50),
      allowNull: false,
      primaryKey: true
    },
    name: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    email: {
      type: DataTypes.STRING(80),
      allowNull: true
    },
    // The role's name, kept in step with roleId (old tokens and old code read
    // it). Before B10 this alone was the role.
    category: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    // B10 (migration 050): the login's role (dbo.Role). Empty = the system
    // role named by category (rows the data sync adds before go-live).
    roleId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'role_id'
    },
    password: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    teacherId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'Teacher',
        key: 'teacher_id'
      },
      field: 'teacherId'
    },
    // BE-T3: disabled when the linked staff record is archived. Non-destructive.
    // The underlying `is_deleted` column is added by a manual migration.
    isDeleted: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      field: 'is_deleted'
    }
  }, {
    sequelize,
    tableName: 'User_account',
    schema: 'dbo',
    timestamps: false,
    indexes: [
      {
        name: "PK__User_acc__F3DBC5737B0A1D14",
        unique: true,
        fields: [
          { name: "username" },
        ]
      },
    ]
  });

  // _.sync()

export default _