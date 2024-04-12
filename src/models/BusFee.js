import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";


const busFee = sequelize.define('busFee', {
    busFeeId: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      field: 'bus_fee_id'
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
    tableName: 'Bus_fee',
    schema: 'dbo',
    timestamps: false,
    indexes: [
      {
        name: "PK__Bus_fee__5EDFD2CE0026367A",
        unique: true,
        fields: [
          { name: "bus_fee_id" },
        ]
      },
    ]
  });



export default busFee