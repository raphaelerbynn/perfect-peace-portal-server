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
      type: DataTypes.BOOLEAN,
      allowNull: true,
      field: 'active'
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