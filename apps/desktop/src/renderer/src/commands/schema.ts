import type { JSONSchema } from '@codeswim/contract'

// Validates `value` against the structural subset of JSON Schema described
// on the `JSONSchema` type. Returns an error message, or null when the value
// is acceptable. Deliberately not a general JSON Schema implementation — see
// that type's doc comment for what's out of scope. Command-specific rules
// (paths, current selection, cross-field constraints) belong in a command's
// own `validate`, which runs after this passes.
export function validateAgainstSchema(value: unknown, schema: JSONSchema, path = 'args'): string | null {
  if (value === null || value === undefined) {
    if (schema.nullable) return null
    if (schema.type && schema.type !== 'null') return `${path}: required`
    return null
  }
  if (schema.enum && !schema.enum.includes(value as string | number | boolean | null)) {
    return `${path}: must be one of ${JSON.stringify(schema.enum)}`
  }
  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) {
        return `${path}: expected an object`
      }
      const obj = value as Record<string, unknown>
      for (const key of schema.required ?? []) {
        if (!(key in obj)) return `${path}.${key}: required`
      }
      for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
        if (!(key in obj)) continue
        const err = validateAgainstSchema(obj[key], propSchema, `${path}.${key}`)
        if (err) return err
      }
      return null
    }
    case 'array': {
      if (!Array.isArray(value)) return `${path}: expected an array`
      if (schema.items) {
        for (let i = 0; i < value.length; i++) {
          const err = validateAgainstSchema(value[i], schema.items, `${path}[${i}]`)
          if (err) return err
        }
      }
      return null
    }
    case 'string':
      return typeof value === 'string' ? null : `${path}: expected a string`
    case 'number':
      return typeof value === 'number' ? null : `${path}: expected a number`
    case 'boolean':
      return typeof value === 'boolean' ? null : `${path}: expected a boolean`
    default:
      return null
  }
}
