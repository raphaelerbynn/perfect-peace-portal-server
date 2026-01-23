import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";


const _ = sequelize.define('feeCheck', {
        value: {
        type: DataTypes.BOOLEAN,
        allowNull: false
        }
    },
    {
        sequelize,
        tableName: 'FeeCheck',
        schema: 'dbo',
        timestamps: false
    }
);

export default _;