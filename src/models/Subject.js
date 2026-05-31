import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";


const _ = sequelize.define('subject', {
    subjectId: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      field: 'subject_id'
    },
    name: {
      type: DataTypes.STRING(50),
      allowNull: false
    },
    examTotalMarks: {
      type: DataTypes.DECIMAL(18,0),
      allowNull: true,
      field: 'exam_total_marks'
    },
    classTotalMarks: {
      type: DataTypes.DECIMAL(18,0),
      allowNull: true,
      field: 'class_total_marks'
    },
    examPercentage: {
      type: DataTypes.DECIMAL(18,0),
      allowNull: true,
      field: 'exam_percentage'
    },
    classPercentage: {
      type: DataTypes.DECIMAL(18,0),
      allowNull: true,
      field: 'class_percentage'
    },
    passMarks: {
      type: DataTypes.DECIMAL(18,0),
      allowNull: true,
      field: 'pass_marks'
    },
    // BE-U: soft-delete / archive flag (mirrors Student/Teacher). The matching
    // `is_deleted` column + the unique index on `name` are added by a MANUAL
    // migration (see service notes) — we only DECLARE the attribute here. The
    // model's sync() is intentionally left commented out; nothing here triggers
    // a schema sync at import time.
    isDeleted: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      field: 'is_deleted'
    }
  }, {
    sequelize,
    tableName: 'Subject',
    schema: 'dbo',
    timestamps: false,
    indexes: [
      {
        name: "PK__Subject__5004F660D284488C",
        unique: true,
        fields: [
          { name: "subject_id" },
        ]
      },
    ]
  });


export default _