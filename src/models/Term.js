import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

const term = sequelize.define('term', {
    termId: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      field: 'term_id'
    },
    term: {
      type: DataTypes.STRING(10),
      allowNull: true,
      field: 'term'
    },
    startDate: {
      type: DataTypes.DATEONLY,
      allowNull: true,
      field: 'start_date'
    },
    endDate: {
      type: DataTypes.DATEONLY,
      allowNull: true,
      field: 'end_date'
    },
    autoCloseDate: {
      type: DataTypes.DATEONLY,
      allowNull: true,
      field: 'auto_close_date'
    },
    active: {
      // BE-D13: an "inactive" term must never be NULL. NULL active breaks every
      // term-scoped read (`where: { active: true }` silently excludes NULL rows,
      // and there is no guaranteed single active term). New rows default to
      // inactive; setTerm()/editTerm() flip exactly one row to active inside a
      // transaction. NOTE: there is NO import-time sequelize.sync(), so this only
      // governs new INSERTs from the ORM - the live DB column must be migrated
      // separately (see report: ALTER TABLE Term ... NOT NULL DEFAULT 0).
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      field: 'active'
    },
    promotedByOldSystem: {
      // Migration 028: a Term 3 the old system already promoted on (before
      // go-live). The Promotion page must not move those pupils again.
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      field: 'promoted_by_old_system'
    },
    academicYearId: {
      // Migration 029 (B7): the academic year this term belongs to. Old terms
      // with no dates have none.
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'academic_year_id'
    },
    nextTermBegins: {
      // Migration 013 (A5a): printed on report cards as "NEXT TERM BEGINS".
      type: DataTypes.DATEONLY,
      allowNull: true,
      field: 'next_term_begins'
    }
  }, {
    sequelize,
    tableName: 'Term',
    schema: 'dbo',
    timestamps: false,
    indexes: [
      {
        name: "PK__Term__4CCB06344A96F70E",
        unique: true,
        fields: [
          { name: "term_id" },
        ]
      },
    ]
  });

// term.sync() 



export default term;