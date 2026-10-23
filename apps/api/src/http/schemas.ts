import { Type, type TSchema } from 'typebox';

export const Problem = Type.Object(
  {
    type: Type.String(),
    title: Type.String(),
    status: Type.Integer(),
    code: Type.String(),
    detail: Type.Optional(Type.String()),
    requestId: Type.Optional(Type.String()),
    errors: Type.Optional(
      Type.Array(Type.Object({ path: Type.Optional(Type.String()), message: Type.Optional(Type.String()) })),
    ),
    region: Type.Optional(Type.String()),
    appUrl: Type.Optional(Type.String()),
    retryAfter: Type.Optional(Type.Integer()),
  },
  { $id: 'Problem', additionalProperties: true },
);

export const Uuid = Type.String({ format: 'uuid' });
export const CivilDate = Type.String({ format: 'date', pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
export const Nullable = <T extends TSchema>(s: T) => Type.Union([s, Type.Null()]);

export const CursorQuery = Type.Object({
  cursor: Type.Optional(Type.String({ maxLength: 500 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
});

export const Page = <T extends TSchema>(item: T) =>
  Type.Object({ data: Type.Array(item), nextCursor: Nullable(Type.String()) });

export function encodeCursor(values: unknown[]): string {
  return Buffer.from(JSON.stringify(values)).toString('base64url');
}
export function decodeCursor<T extends unknown[]>(cursor: string | undefined): T | undefined {
  if (!cursor) return undefined;
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return Array.isArray(v) ? (v as T) : undefined;
  } catch {
    return undefined;
  }
}
