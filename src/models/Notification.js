import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";


const _ = sequelize.define('notification', {
    notificationId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      autoIncrement: true,
      field: 'notification_id'
    },
    notification: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    class: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    date: {
      type: DataTypes.DATE,
      allowNull: true
    }
  }, {
    sequelize,
    tableName: 'Notification',
    schema: 'dbo',
    timestamps: false,
    indexes: [
      {
        name: "PK__tmp_ms_x__E059842FC07860E4",
        unique: true,
        fields: [
          { name: "notification_id" },
        ]
      },
    ]
  });


export default _