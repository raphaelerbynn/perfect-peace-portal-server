import { Sequelize } from 'sequelize';
// import config from './config.js';
import dotenv from "dotenv";
dotenv.config();
// const env = 'development';
// const dbConfig = config[env];

// process.env.DB_USERNAME,
//       password: process.env.DB_PASSWORD,
//       database: process.env.DB_NAME,
//       host: process.env.DB_HOST,

const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USERNAME,
  process.env.DB_PASSWORD,
  {
    host: process.env.DB_HOST,
    dialect: "mysql",
  }
);

// sequelize.options.logging = console.log;
// sequelize.sync();

export default sequelize;