import { Sequelize, DataTypes } from 'sequelize';
import dotenv from "dotenv";
dotenv.config();

// NUMERIC columns (scores, money: NUMERIC(18,2)) come back from Postgres as
// text ("980.00"). Read them as numbers so balances add up and screens show
// 980 / 7.5, not "980.00". Two decimal places are safe as a JS number.
// (Sequelize's own DECIMAL parser wins over pg's, so it is the one to replace.)
DataTypes.postgres.DECIMAL.parse = (v) => (v === null ? null : Number(v));

const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USERNAME,
  process.env.DB_PASSWORD,
  {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 5432,
    dialect: "postgres",
    logging: false,
    pool: {
      max: 5,
      min: 0,
      acquire: 30000,
      idle: 10000
    }
  }
);

export default sequelize;