import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";


const _ = sequelize.define('feedingFee', {
    feedingFeeId: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      field: 'feeding_fee_id'
    },
    teacher: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    class: {
      type: DataTypes.STRING(10),
      allowNull: true
    },
    amount: {
      type: DataTypes.DECIMAL(18,0),
      allowNull: true
    },
    date: {
      type: DataTypes.DATEONLY,
      allowNull: true
    }
  }, {
    sequelize,
    tableName: 'Feeding_fee',
    schema: 'dbo',
    timestamps: false,
    indexes: [
      {
        name: "PK__Feeding___9517B3B56CD859AD",
        unique: true,
        fields: [
          { name: "feeding_fee_id" },
        ]
      },
    ]
  });


export default _