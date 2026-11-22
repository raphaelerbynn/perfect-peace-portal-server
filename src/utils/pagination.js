// Opt-in pagination for list endpoints (Phase 0.4.6), same behaviour as the
// existing inline blocks (e.g. services/news.js): no ?limit => no paging, so
// old clients that expect the whole list keep working.

const DEFAULT_MAX_LIMIT = 200;

// ({ page, limit }) -> { page, limit, offset } or null when not paginating.
const parsePagination = ({ page, limit } = {}, { maxLimit = DEFAULT_MAX_LIMIT } = {}) => {
  const parsedLimit = parseInt(limit, 10);
  if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) return null;
  const safeLimit = Math.min(parsedLimit, maxLimit);
  const parsedPage = parseInt(page, 10);
  const safePage = Number.isInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  return { page: safePage, limit: safeLimit, offset: (safePage - 1) * safeLimit };
};

// Wrap a Sequelize findAndCountAll result in the paginated response shape used
// by /students: { <key>, total, page, limit, totalPages }.
const paginatedResponse = (key, { rows, count }, paging) => ({
  [key]: rows,
  total: count,
  page: paging.page,
  limit: paging.limit,
  totalPages: Math.ceil(count / paging.limit),
});

export { parsePagination, paginatedResponse, DEFAULT_MAX_LIMIT };
