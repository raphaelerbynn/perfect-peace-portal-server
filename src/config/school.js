// Single source of truth for school-wide domain constants.

// Class IDs 39 and 40 are the graduated / alumni classes. Students whose
// `classId` is one of these have left the school and must be EXCLUDED from any
// "active student" count (dashboard summary, per-class bar chart, etc.). They
// are kept in the DB for historical/result lookups, hence we filter them out at
// query time rather than deleting the rows. Centralising the literals here
// avoids the magic-number 39/40 being scattered across services.
export const GRADUATED_CLASS_IDS = [39, 40];
