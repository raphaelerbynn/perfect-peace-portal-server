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
    endDate: {
      type: DataTypes.DATEONLY,
      allowNull: true,
      field: 'end_date'
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



export default term;