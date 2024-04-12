import { getBusFeeGraph, getExpenseGraph, getExtraClassesGraph, getFeedingGraph, getFeesGraph } from "../services/graph.js";

const fetchExpenseGraph = async (req, res, next) => {
    const _values = req.query;
    try {
      const data = await getExpenseGraph(_values);
      res.json({
        groupBy: _values.groupBy,
        values: data
      });
    } catch (error) {
      console.log(error);
      next(error);
    }
  }

const fetchIncomeGraph = async (req, res, next) => {
    const _values = req.query;
    try {
      const _busfee = await getBusFeeGraph(_values);
      const _feeding = await getFeedingGraph(_values);
      const _extraClasses = await getExtraClassesGraph(_values);
      
      res.json({
        groupBy: _values.groupBy,
        busFee: _busfee,
        feeding: _feeding,
        extraClasses: _extraClasses,
      });
    } catch (error) {
      console.log(error);
      next(error);
    }
  }

const fetchFeesGraph = async (req, res, next) => {
    const _values = req.query;
    try {
      const data = await getFeesGraph(_values);

      res.json({
        groupBy: _values.groupBy,
        values: data
      });
    } catch (error) {
      console.log(error);
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
        fees: _fees,
        expense: _expense,
      });
    } catch (error) {
      console.log(error);
      next(error);
    }
  }

export {
    fetchExpenseGraph, fetchIncomeGraph, fetchFeesGraph, fetchFeesVsExpenseGraph
}