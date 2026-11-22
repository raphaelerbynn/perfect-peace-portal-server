// Money helpers for new features (Phase 0.4.6). Sequelize returns DECIMAL
// columns as strings ("350.50"); these convert safely and round to 2 places
// so sums of cedis/pesewas don't drift (0.1 + 0.2 problems).

// String/number/null -> number. Throws on anything that is not a number, so a
// bad value fails loudly instead of turning into NaN in a balance.
const toNum = (value) => {
  if (value === null || value === undefined || value === "") return 0;
  const n = typeof value === "number" ? value : Number(String(value).replace(/,/g, "").trim());
  if (!Number.isFinite(n)) throw new Error(`Not a money amount: ${JSON.stringify(value)}`);
  return n;
};

// Round half away from zero to 2 decimal places (GH₵ 1.005 -> 1.01).
const round2 = (value) => {
  const n = toNum(value);
  return (Math.sign(n) * Math.round((Math.abs(n) + Number.EPSILON) * 100)) / 100;
};

// Sum a list of amounts (or of item[key]) exactly to the pesewa.
const sumMoney = (items, key) =>
  round2(
    items.reduce((total, item) => {
      const v = key ? item?.[key] : item;
      return total + Math.round(toNum(v) * 100);
    }, 0) / 100
  );

// Display: "GH₵ 1,234.50".
const formatGhs = (value) =>
  `GH₵ ${round2(value).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// True when the amount has at most 2 decimal places (cedis and pesewas):
// 149.5 and 149.50 yes, 149.505 no.
const isPesewaAmount = (value) => {
  const n = toNum(value);
  return Math.abs(Math.round(n * 100) - n * 100) < 1e-6;
};

export { toNum, round2, sumMoney, formatGhs, isPesewaAmount };
