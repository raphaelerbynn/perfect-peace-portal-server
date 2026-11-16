// AI-0: enough JSON Schema to catch a model drifting off the shape, ported
// from SchoolPro's checkAgainstSchema: required keys, types, enums, arrays,
// nested objects, anyOf/oneOf, plus minItems/maxItems and maxLength. $ref is
// not resolved (a schema built from refs passes rather than failing wrongly).
// Returns a description of the first problem, or null when the value matches.

const matchesType = (value, type) => {
  switch (type) {
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
};

const describe = (value) => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value);

export const checkAgainstSchema = (value, schema, path = "$") => {
  if (!schema || typeof schema !== "object" || "$ref" in schema) return null;

  const alternatives = schema.anyOf || schema.oneOf;
  if (Array.isArray(alternatives) && alternatives.length) {
    return alternatives.some((option) => checkAgainstSchema(value, option, path) === null)
      ? null
      : `${path} matched none of the allowed shapes`;
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return `${path} is not one of the allowed values`;

  const types = typeof schema.type === "string" ? [schema.type] : schema.type;
  if (Array.isArray(types) && types.length && !types.some((t) => matchesType(value, t))) {
    return `${path} should be ${types.join(" or ")}, got ${describe(value)}`;
  }

  if (typeof value === "string" && Number.isInteger(schema.maxLength) && value.length > schema.maxLength) {
    return `${path} is longer than ${schema.maxLength} characters`;
  }

  if (matchesType(value, "object")) {
    for (const key of schema.required || []) {
      if (value[key] === undefined) return `${path}.${key} is required but missing`;
    }
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (value[key] === undefined) continue;
      const problem = checkAgainstSchema(value[key], sub, `${path}.${key}`);
      if (problem) return problem;
    }
    return null;
  }

  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) return `${path} needs at least ${schema.minItems} items`;
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) return `${path} has more than ${schema.maxItems} items`;
    if (schema.items && typeof schema.items === "object") {
      for (let i = 0; i < value.length; i += 1) {
        const problem = checkAgainstSchema(value[i], schema.items, `${path}[${i}]`);
        if (problem) return problem;
      }
    }
  }
  return null;
};
