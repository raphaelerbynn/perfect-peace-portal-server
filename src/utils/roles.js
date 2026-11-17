// B10: the office (management) login roles, stored in UserAccount.category and
// carried in the management JWT as `category`. Every role check uses these
// names; there is no permission table (decision 2026-11-17: one fixed extra
// role, Head Teacher, next to the original three).
export const ADMINISTRATOR = "Administrator";
export const CLASS_TEACHER = "Class Teacher";
export const ACCOUNTANT = "Accountant";
export const HEAD_TEACHER = "Head Teacher";

export const OFFICE_ROLES = [ADMINISTRATOR, CLASS_TEACHER, ACCOUNTANT, HEAD_TEACHER];

// Roles an Administrator may give when creating an office login (People ->
// Office logins). Administrator logins are provisioned by the seed script only.
export const ASSIGNABLE_ROLES = [CLASS_TEACHER, ACCOUNTANT, HEAD_TEACHER];

const categoryOf = (user) => user?.category;

export const isAdministrator = (user) => categoryOf(user) === ADMINISTRATOR;
export const isHeadTeacher = (user) => categoryOf(user) === HEAD_TEACHER;
export const isClassTeacher = (user) => categoryOf(user) === CLASS_TEACHER;

// Academic work for EVERY class (no own-class scoping): the Administrator and
// the Head Teacher. A Class Teacher is limited to their own class.
export const isSchoolWideAcademic = (user) => isAdministrator(user) || isHeadTeacher(user);
