// ---------------------------------------------------------------------------
// The KG / nursery report card's four developmental rating sections, with
// their items. ONE copy on the server: the teacher portal gets it from
// GET /teacher/kg-ratings, never from its own list.
//
// The strings (typos included: "rything", "Demonstatrate", "hoppinh") are
// exactly what the office form writes (admin AddNurseryResult.jsx,
// POST /add-kg-result) and what is already stored in KG_assessment, so the
// report card and the office form keep matching the rows. Don't "fix" them
// here without a data migration and the same change in the office form.
//
// Stored in KG_assessment as one row per (student, termId, class, category,
// assessment), category UPPER-CASED (services/results.js createKGResult),
// with one 0/1 flag per rating.
// ---------------------------------------------------------------------------

export const KG_RATING_SECTIONS = [
  {
    key: "languageDevelopment",
    category: "Language Development (Reading, Listening and Oral Skills)",
    items: [
      "Participate in conversation",
      "Identifying rything words",
      "Recites letter sounds A-Z",
      "Interested in reading",
      "Enjoys and values reading",
      "Recognize and identifies letters (Upper and lower case)",
      "Recognize and pronounce own name in print",
      "Able to pronounce 2 and 3 letter words",
      "Forms simple sentence",
      "Listens to short story",
    ],
  },
  {
    key: "personalDevelopment",
    category: "Personal / Social / Emotional Development",
    items: [
      "Follows classroom rules and routines",
      "Plays well with other children",
      "Complete tasks",
      "Expresses emotions in appropriate way",
      "Cooperate and shares with others",
      "Takes care of personal needs",
    ],
  },
  {
    key: "physicalDevelopment",
    category: "Physical Development",
    items: [
      "Demonstatrate basic locomotor abilities (running, jumping, hoppinh, catching, etc)",
      "Shows balance while moving",
      "Holds pencils and crayons correctly",
      "Fit small things together",
      "Shows interest in writing",
    ],
  },
  {
    key: "cognitiveDevelopment",
    category: "Cognitive Development (Position, Direction, Thinking)",
    items: [
      "Shows persistence in approaching task",
      "Compares and measures",
      "Recognize basic shapes",
      "Picture making",
      "Recognizes primary colours",
      "Identify and count numerals",
      "Recognize patterns(Up and Down)",
      "Identify body parts",
      "Recognize secondary colors",
    ],
  },
];

/** Rating value -> KG_assessment flag column, in the report card's column order (1..5). */
export const KG_RATINGS = [
  { value: "satisfactory", label: "Satisfactory", field: "satisfactory" },
  { value: "improved", label: "Improved", field: "improved" },
  { value: "needs_improvement", label: "Needs improvement", field: "needsImprovement" },
  { value: "unsatisfactory", label: "Unsatisfactory", field: "unsatisfactory" },
  { value: "not_applicable", label: "Not applicable", field: "notApplicable" },
];

export const KG_RATING_ITEM_COUNT = KG_RATING_SECTIONS.reduce((n, s) => n + s.items.length, 0);

/** The stored form of a category (createKGResult upper-cases it). */
export const storedCategory = (category) => String(category).toUpperCase();

export const KG_RATING_STORED_CATEGORIES = KG_RATING_SECTIONS.map((s) => storedCategory(s.category));

/** A section by its display name (any case) or its key, or null. */
export const findRatingSection = (name) => {
  const upper = String(name ?? "").trim().toUpperCase();
  return KG_RATING_SECTIONS.find((s) => s.key === name || storedCategory(s.category) === upper) || null;
};

/** 0/1 flags for one rating value (same mapping as the office's addKGResult). */
export const ratingFlags = (value) =>
  Object.fromEntries(KG_RATINGS.map((r) => [r.field, r.value === value ? 1 : 0]));

/** The rating a stored row carries, or null (same precedence as utils/func.js transformReturningKGResult). */
export const ratingOfRow = (row) => KG_RATINGS.find((r) => Number(row?.[r.field]))?.value ?? null;
