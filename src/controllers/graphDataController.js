import { getExpenseGraph, getFeesGraph, getIncomeGraph, getProfitLoss } from "../services/graph.js";

// Coerce SQL SUM results (which come back as strings) into numbers so charts
// receive numeric values. Works for both plain objects and Sequelize instances.
const toNumericRows = (data) =>
  (data || []).map((r) => ({
    label: r.label ?? r.get?.("label"),
    totalAmount: Number(r.totalAmount ?? r.get?.("totalAmount")) || 0,
  }));

const fetchExpenseGraph = async (req, res, next) => {
    const _values = req.query;
    try {
      const data = await getExpenseGraph(_values);
      res.json({
        groupBy: _values.groupBy,
        values: toNumericRows(data)
      });
    } catch (error) {
      next(error);
    }
  }

const fetchIncomeGraph = async (req, res, next) => {
    const _values = req.query;
    try {
      const data = await getIncomeGraph(_values);
      res.json({
        groupBy: _values.groupBy,
        values: toNumericRows(data)
      });
    } catch (error) {
      next(error);
    }
  }

const fetchFeesGraph = async (req, res, next) => {
    const _values = req.query;
    try {
      const data = await getFeesGraph(_values);
      res.json({
        groupBy: _values.groupBy,
        values: toNumericRows(data)
      });
    } catch (error) {
      next(error);
    }
  }

const fetchFeesVsExpenseGraph = async (req, res, next) => {
    const _values = req.query;
    try {
      const _fees = await getFeesGraph(_values);
      const _expense = await getExpenseGraph(_values);

      res.json({
        groupBy: _values.groupBy,
        fees: toNumericRows(_fees),
        expense: toNumericRows(_expense),
      });
    } catch (error) {
      next(error);
    }
  }

const fetchProfitLoss = async (req, res, next) => {
  const _values = req.query;
  try {
    const data = await getProfitLoss(_values);
    res.json({
      groupBy: _values.groupBy || null,
      values: data,
    });
  } catch (error) {
    next(error);
  }
}



export {
  fetchExpenseGraph, fetchIncomeGraph, fetchFeesGraph, fetchFeesVsExpenseGraph, fetchProfitLoss
}