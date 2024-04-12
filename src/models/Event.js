import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";


const event = sequelize.define('event', {
    eventId: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      field: 'event_id'
    },
    name: {
      type: DataTypes.STRING(50),
      allowNull: false
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    date: {
      type: DataTypes.DATEONLY,
      allowNull: true
    },
    time: {
      type: DataTypes.TIME,
      allowNull: true
    },
    created_at: {
      type: DataTypes.STRING,
      allowNull: true
    }
  }, {
    sequelize,
    tableName: 'Event',
    schema: 'dbo',
    timestamps: false,
    indexes: [
      {
        name: "PK__Event__2370F727B3E0221E",
        unique: true,
        fields: [
          { name: "event_id" },
        ]
      },
    ]
  });


export default event