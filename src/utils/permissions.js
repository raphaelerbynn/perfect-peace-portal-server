// B10: staff roles and permissions.
//
// Every office (management) route is gated by a PERMISSION, never by a role
// name. A role is a named set of permissions:
//   - three SYSTEM roles (Administrator, Class Teacher, Accountant), fixed in
//     code below and read-only. Their sets reproduce exactly what each role
//     reached before B10 (proved route by route in roleAccess.test.js);
//   - CUSTOM roles the school makes (Settings -> Roles), stored in
//     dbo.Role + dbo.Role_permission (migration 050).
//
// The catalogue lives here, in code (not a table): a permission only means
// something when code checks it, so a key and its check ship together. Keys
// are `module.action`; the picker groups them by module.
//
// Two keys are not a screen but a reach:
//   academics.all_classes        every class. Without it the login is limited
//                                to the class linked to it (its staff record's
//                                class), as a Class Teacher always was.
//   academics.edit_closed_terms  change results and registers of closed terms
//                                and any day's register. Without it: the open
//                                term only.

export const MODULES = [
  { key: "overview", label: "Overview" },
  { key: "academics", label: "Class access" },
  { key: "students", label: "Pupils" },
  { key: "staff", label: "Staff" },
  { key: "staff_attendance", label: "Staff attendance" },
  { key: "classes", label: "Classes" },
  { key: "subjects", label: "Subjects & teachers" },
  { key: "terms", label: "Terms & academic years" },
  { key: "results", label: "Results" },
  { key: "report_cards", label: "Report cards" },
  { key: "grading", label: "Grading scales" },
  { key: "attendance", label: "Pupil attendance" },
  { key: "timetable", label: "Timetable" },
  { key: "promotion", label: "Promotion" },
  { key: "reports", label: "Academic reports" },
  { key: "fees", label: "Fees & payments" },
  { key: "billing", label: "Billing & discounts" },
  { key: "invoices", label: "Invoices & credit notes" },
  { key: "accounting", label: "Accounting" },
  { key: "payroll", label: "Payroll" },
  { key: "sms", label: "SMS messages" },
  { key: "news", label: "News & events" },
  { key: "settings", label: "School settings" },
  { key: "users", label: "Office logins" },
  { key: "roles", label: "Roles & permissions" },
  { key: "ai", label: "AI assistant" },
];

// [key, plain-English label]. The module is the part before the dot.
const CATALOGUE_ROWS = [
  ["overview.dashboard", "See the dashboard and analytics: pupil, staff and class counts, and who owes fees (own class only without “Every class”)"],
  ["overview.lookups", "Look up pupils and the timetable from other screens (fee, billing and invoice pickers), without the Students or Timetable pages"],

  ["academics.all_classes", "Every class: results, registers, report cards, pupil files, the pupil list and who owes, for all classes (without this: only the class linked to their login; money screens are never limited by class)"],
  ["academics.edit_closed_terms", "Change results and registers of closed terms (without this: the open term only)"],

  ["students.view", "See the Students page: the pupil list and records"],
  ["students.edit", "Add pupils and edit their records"],
  ["students.delete", "Delete pupils"],
  ["students.view_files", "See pupils' photos and documents"],
  ["students.manage_files", "Upload and remove pupils' photos and documents"],

  ["staff.view", "See the staff list and staff photos"],
  ["staff.view_sensitive", "See staff bank, account, TIN, SSNIT and salary details"],
  ["staff.edit", "Add staff and edit their records"],
  ["staff.delete", "Delete staff"],
  ["staff.files", "See, upload and remove staff documents and change staff photos"],

  ["staff_attendance.view", "See the staff register and attendance summaries"],
  ["staff_attendance.mark", "Mark the staff register"],

  ["classes.view", "See classes"],
  ["classes.manage", "Add, edit and delete classes, and set each class's next class"],

  ["subjects.view", "See subjects"],
  ["subjects.manage", "Add and delete subjects"],
  ["subjects.assign_teachers", "Set who teaches each subject in each class"],

  ["terms.view", "See terms and academic years"],
  ["terms.manage", "Set up, open and close terms and academic years (closing rolls up the registers)"],

  ["results.view", "See results, marks and year results"],
  ["results.enter", "Enter and upload scores"],
  ["results.delete", "Delete a pupil's result"],
  ["results.notify_ready", "Tell parents a class's results are ready"],
  ["results.remind_teachers", "Remind teachers to enter scores"],

  ["report_cards.view", "Check and print report cards"],

  ["grading.view", "See grading scales"],
  ["grading.manage", "Add, edit and delete grading scales"],

  ["attendance.view", "See pupil registers and attendance counts"],
  ["attendance.mark", "Mark and clear pupil registers"],

  ["timetable.view", "See the Timetable page"],
  ["timetable.manage", "Build and change the timetable"],

  ["promotion.manage", "Promote pupils at the end of the year (rules, preview, accept)"],
  ["promotion.view_history", "See a pupil's promotion history"],

  ["reports.academic_class", "Academic reports for a class (own class only without “Every class”)"],
  ["reports.academic_school", "School-wide academic reports (every class, term overview)"],

  ["fees.view", "See fee payments and pupils' fee statements"],
  ["fees.record", "Record fee payments"],
  ["fees.reverse", "Reverse a fee payment"],
  ["fees.setup", "Set class fees and a pupil's own fees"],
  ["fees.other_collections", "Feeding, bus and extra classes money (see, record, delete)"],

  ["billing.bill_term", "Bill a term (with arrears carried forward)"],
  ["billing.give_discounts", "Give pupils discounts and end them"],
  ["billing.discount_types", "Set up the kinds of discount and their amounts"],

  ["invoices.view", "See and print invoices and credit notes"],
  ["invoices.manage", "Make, issue and void invoices"],
  ["invoices.credit_notes", "Make and void credit notes"],

  ["accounting.view", "See income, expenses and the money charts"],
  ["accounting.manage", "Record and delete income, expenses and their categories"],

  ["payroll.view", "See salaries and salary payments"],
  ["payroll.manage", "Set salaries and record or delete salary payments"],

  ["sms.send", "Send SMS messages to parents and staff"],

  ["news.view", "See news and events"],
  ["news.post", "Write news posts and manage their own posts (own class only without “Every class”)"],
  ["news.manage", "Manage all news and events: any post, pin, hide comments, the old events list"],

  ["settings.manage", "School settings: name, logo, colours, admission numbers, notification switches"],

  ["users.manage", "Create office logins and change which role a login has"],
  ["roles.manage", "Create and edit roles and their permissions"],

  // AI assistant. Each feature also needs AI switched on (Settings -> AI) and
  // the monthly budget; the keys only say who may use it.
  ["ai.settings", "AI settings: switch AI and each AI feature on or off, the monthly GH₵ budget, tone, usage and what AI has cost"],
  ["ai.suggestions.review", "See, edit, approve and discard AI drafts (announcement drafts become a news post or SMS text only when approved)"],
  ["ai.ask", "Ask the school: questions answered from the school's records, only on what the role may already see (fees with fee payments, income and expenses with accounting, registers and results with every class, staff with the staff list)"],
  ["ai.papers.view_all", "See every teacher's question papers (read-only)"],
  ["ai.briefing", "The Monday briefing: read it, run it, set its days and delivery, and get it in the office app"],
  ["ai.announcements", "Draft news posts and SMS messages with AI (turning a draft into a news post also needs managing all news)"],
  ["ai.at_risk", "Pupils at risk: the watchlist, its AI notes and the handled / dismissed marks (own class only without “Every class”)"],
];

const moduleOf = (key) => key.slice(0, key.indexOf("."));

export const PERMISSIONS = CATALOGUE_ROWS.map(([key, label]) => ({ key, module: moduleOf(key), label }));
export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);
const KNOWN = new Set(PERMISSION_KEYS);
export const isPermissionKey = (key) => KNOWN.has(key);

// Named constants for the keys code checks outside the route tables.
export const P = Object.freeze({
  ALL_CLASSES: "academics.all_classes",
  EDIT_CLOSED_TERMS: "academics.edit_closed_terms",
  STAFF_VIEW_SENSITIVE: "staff.view_sensitive",
  NEWS_VIEW: "news.view",
  NEWS_POST: "news.post",
  NEWS_MANAGE: "news.manage",
  USERS_MANAGE: "users.manage",
  ROLES_MANAGE: "roles.manage",
  // AI assistant (services/ai, routes/ai*.js)
  AI_SETTINGS: "ai.settings",
  AI_SUGGESTIONS_REVIEW: "ai.suggestions.review",
  AI_ASK: "ai.ask",
  AI_PAPERS_VIEW_ALL: "ai.papers.view_all",
  AI_BRIEFING: "ai.briefing",
  AI_ANNOUNCEMENTS: "ai.announcements",
  AI_AT_RISK: "ai.at_risk",
});

// ------------------------------------------------------------------ system roles
// Fixed ids (seeded by migration 050). A management token without a roleId
// (signed before B10) and an account whose role_id is still empty map to the
// system role named by its category.
export const ADMINISTRATOR = "Administrator";
export const CLASS_TEACHER = "Class Teacher";
export const ACCOUNTANT = "Accountant";

const CLASS_TEACHER_PERMISSIONS = [
  "overview.dashboard",
  "students.view",
  "students.view_files",
  "students.manage_files",
  "classes.view",
  "subjects.view",
  "terms.view",
  "results.view",
  "results.enter",
  "results.delete",
  "results.notify_ready",
  "report_cards.view",
  "grading.view",
  "attendance.view",
  "attendance.mark",
  "timetable.view",
  "promotion.view_history",
  "reports.academic_class",
  "news.view",
  "news.post",
  // AI-4: the at-risk watchlist for their own class (as before B10).
  "ai.at_risk",
];

const ACCOUNTANT_PERMISSIONS = [
  "overview.dashboard",
  // Every pupil (fees are recorded for any pupil), as before B10.
  "academics.all_classes",
  // Pupils and the timetable for pickers, as before B10, but not the Students
  // or Timetable pages (the Accountant never had them).
  "overview.lookups",
  "classes.view",
  "terms.view",
  "fees.view",
  "fees.record",
  "fees.setup",
  "fees.other_collections",
  "billing.bill_term",
  "billing.give_discounts",
  "invoices.view",
  "invoices.manage",
  "accounting.view",
  "accounting.manage",
  "payroll.view",
  "payroll.manage",
  "news.view",
  // AI-1: Ask the school; fees.view / accounting.view limit it to the finance tools (as before B10).
  "ai.ask",
];

export const SYSTEM_ROLES = Object.freeze([
  {
    roleId: 1,
    name: ADMINISTRATOR,
    description: "Everything, for every class.",
    permissions: Object.freeze([...PERMISSION_KEYS]),
  },
  {
    roleId: 2,
    name: CLASS_TEACHER,
    description: "Results, registers, report cards and news for the class linked to the login.",
    permissions: Object.freeze([...CLASS_TEACHER_PERMISSIONS]),
  },
  {
    roleId: 3,
    name: ACCOUNTANT,
    description: "Fees, billing, invoices, accounting and payroll.",
    permissions: Object.freeze([...ACCOUNTANT_PERMISSIONS]),
  },
]);

export const SYSTEM_ROLE_NAMES = SYSTEM_ROLES.map((r) => r.name);
export const systemRoleById = (id) => SYSTEM_ROLES.find((r) => r.roleId === Number(id)) || null;
// Exact name, as authorizeRoles compared it before B10 ("administrator" was never one).
export const systemRoleByName = (name) => SYSTEM_ROLES.find((r) => r.name === name) || null;

// ------------------------------------------------------------------ checks
// `user` is req.user after authenticateManagementUser (or the news viewer),
// which puts the role's permissions on it as a Set. Fail closed: a user whose
// permissions were never loaded has none (the token's claims are never read
// as permissions).
export const permissionsOf = (user) => (user?.permissions instanceof Set ? user.permissions : null);
export const hasPermission = (user, key) => !!permissionsOf(user)?.has(key);
export const hasAnyPermission = (user, keys) => keys.some((k) => hasPermission(user, k));

// B10 review: which teacher a class is linked to is what limits a login
// without academics.all_classes to "its own class", so only a holder of
// academics.all_classes may change that link. `actor` undefined = an internal
// call (no request); every request passes req.user.
export const mayRelinkClasses = (actor) => actor === undefined || hasPermission(actor, P.ALL_CLASSES);
