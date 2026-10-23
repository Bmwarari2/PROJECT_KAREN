import type { FastifyInstance, FastifySchemaCompiler } from 'fastify';
import { TypeBoxValidatorCompiler } from '@fastify/type-provider-typebox';
import type { TSchema } from 'typebox';
import { Value } from 'typebox/value';

type ValidationOutcome = ReturnType<ReturnType<FastifySchemaCompiler<TSchema>>>;

/**
 * Request validation with mass-assignment protection (ASVS V15.3.3, ADR-0134). Every part is
 * validated against its TypeBox schema. Request bodies are then cleaned: properties the route's
 * schema does not declare are removed (at every level), so a handler can never receive, store or
 * act on a field that is not part of that action. Schemas that say `additionalProperties: false`
 * refuse unknown fields instead (400); `additionalProperties: true` or a schema (records, free-form
 * maps) keeps them, which must be a deliberate choice in the route.
 */
export const validatorCompiler: FastifySchemaCompiler<TSchema> = (route) => {
  const validate = TypeBoxValidatorCompiler(route);
  if (route.httpPart !== 'body') return validate;
  return (value: unknown): ValidationOutcome => {
    const result = validate(value) as { value?: unknown; error?: unknown };
    if (result.error) return result as ValidationOutcome;
    return { value: cleanBody(route.schema, result.value) };
  };
};

/** Removes undeclared properties from a validated body (the value is mutated, like TypeBox's Clean). */
export function cleanBody(schema: TSchema, value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  return Value.Clean(schema, value);
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Every route's request body schema (for the mass-assignment contract test). */
    routeBodies: Array<{ method: string; url: string; schema: TSchema }>;
  }
}

/** Records body schemas as routes are added (call before any route is registered). */
export function recordRouteBodies(app: FastifyInstance) {
  const bodies: FastifyInstance['routeBodies'] = [];
  app.decorate('routeBodies', bodies);
  app.addHook('onRoute', (r) => {
    const body = (r.schema as { body?: TSchema } | undefined)?.body;
    if (body)
      bodies.push({
        method: ([] as string[]).concat(r.method as string | string[]).join(','),
        url: r.url,
        schema: body,
      });
  });
}
