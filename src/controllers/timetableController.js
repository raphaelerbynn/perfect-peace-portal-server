import {
  bulkCreateEntries,
  copyTimetable,
  createEntry,
  DAYS,
  deleteEntry,
  getPortalTimetable,
  listPeriods,
  listTimetable,
  replacePeriods,
  syncAssignmentsFromTimetable,
  updateEntry,
} from "../services/timetable.js";

// B3: timetable. Office routes in generalRoutes, the portal view in portalRoutes.
const handle = (fn) => async (req, res, next) => {
  try {
    res.json(await fn(req, res));
  } catch (error) {
    next(error);
  }
};
const author = (req) => ({ createdBy: req.user?.username ?? null });

const fetchPeriods = handle(async () => ({ days: DAYS, periods: await listPeriods() }));
const savePeriods = handle(async (req) => ({ days: DAYS, periods: await replacePeriods(req.body?.periods) }));
const fetchTimetable = handle((req) => listTimetable(req.query));
const addTimetableEntry = handle((req) => createEntry(req.body, author(req)));
const editTimetableEntry = handle((req) => updateEntry(req.params.id, req.body, author(req)));
const removeTimetableEntry = handle((req) => deleteEntry(req.params.id));
const addTimetableEntries = handle((req) => bulkCreateEntries(req.body?.entries, author(req)));
const copyTermTimetable = handle((req) => copyTimetable(req.body, author(req)));
const syncTimetableAssignments = handle((req) => syncAssignmentsFromTimetable(req.body, author(req)));
const fetchPortalTimetable = handle((req) => getPortalTimetable(req.user));

export {
  fetchPeriods,
  savePeriods,
  fetchTimetable,
  addTimetableEntry,
  editTimetableEntry,
  removeTimetableEntry,
  addTimetableEntries,
  copyTermTimetable,
  syncTimetableAssignments,
  fetchPortalTimetable,
};
