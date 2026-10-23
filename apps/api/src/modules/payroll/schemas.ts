import { Type } from 'typebox';
import { CivilDate, Nullable, Uuid } from '../../http/schemas';
import { DATE_FORMATS } from './mapping';
import { CONNECTOR_KINDS } from './connectors/types';

const lit = <T extends string>(values: readonly T[]) => Type.Union(values.map((v) => Type.Literal(v)));
const Decimals = Type.Integer({ minimum: 0, maximum: 4 });

export const TransformSchema = Type.Union([
  Type.Object({ type: Type.Literal('date'), format: lit(DATE_FORMATS) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('number'), decimals: Decimals }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('hours'), decimals: Decimals }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('minutes') }, { additionalProperties: false }),
  Type.Object(
    { type: Type.Literal('money'), unit: lit(['major', 'minor'] as const) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('codeMap'),
      map: Type.Record(Type.String({ maxLength: 60 }), Type.String({ maxLength: 60 })),
      default: Type.Optional(Type.String({ maxLength: 60 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('boolean'),
      true: Type.String({ maxLength: 20 }),
      false: Type.String({ maxLength: 20 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal('case'), case: lit(['upper', 'lower'] as const) },
    { additionalProperties: false },
  ),
]);
export const ColumnSchema = Type.Object(
  {
    header: Type.String({ minLength: 1, maxLength: 80 }),
    field: Type.Optional(Type.String({ maxLength: 60 })),
    value: Type.Optional(Type.String({ maxLength: 120 })),
    transform: Type.Optional(TransformSchema),
  },
  { additionalProperties: false },
);
const SectionSchema = Type.Object(
  { enabled: Type.Boolean(), columns: Type.Array(ColumnSchema, { maxItems: 60 }) },
  { additionalProperties: false },
);
export const MappingSchema = Type.Object(
  {
    dateFormat: lit(DATE_FORMATS),
    decimalSeparator: lit(['.', ','] as const),
    delimiter: lit([',', ';', '\t', '|'] as const),
    includeHeader: Type.Boolean(),
    sections: Type.Object(
      {
        hours: Type.Optional(SectionSchema),
        absences: Type.Optional(SectionSchema),
        sickPay: Type.Optional(SectionSchema),
        payChanges: Type.Optional(SectionSchema),
        starters: Type.Optional(SectionSchema),
        leavers: Type.Optional(SectionSchema),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const SftpSchema = Type.Object(
  {
    host: Type.String({ minLength: 1, maxLength: 253, pattern: '^[A-Za-z0-9.:-]+$' }),
    port: Type.Integer({ minimum: 1, maximum: 65535 }),
    username: Type.String({ minLength: 1, maxLength: 100 }),
    directory: Type.String({ maxLength: 300, pattern: '^[A-Za-z0-9._/ -]*$' }),
    hostKeySha256: Type.String({ pattern: '^SHA256:[A-Za-z0-9+/]{43}$' }),
  },
  { additionalProperties: false },
);
export const DeliverySchema = Type.Object(
  { method: lit(['download', 'sftp', 'api'] as const), sftp: Type.Optional(SftpSchema) },
  { additionalProperties: false },
);

const Id = Type.String({ maxLength: 100, pattern: '^[A-Za-z0-9-]+$' });
export const SettingsSchema = Type.Object(
  {
    xeroTenantId: Type.Optional(Id),
    payrollCalendarId: Type.Optional(Id),
    earningsRates: Type.Optional(
      Type.Object(
        { regular: Type.Optional(Id), overtime: Type.Optional(Id), doubleTime: Type.Optional(Id) },
        { additionalProperties: false },
      ),
    ),
    leaveTypes: Type.Optional(Type.Record(Type.String({ maxLength: 60 }), Id)),
    leaveDescriptions: Type.Optional(
      Type.Record(Type.String({ maxLength: 60 }), Type.String({ maxLength: 50 })),
    ),
    employees: Type.Optional(Type.Record(Type.String({ maxLength: 40 }), Id)),
  },
  { additionalProperties: false },
);

export const ConnectorBody = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 120 }),
    kind: lit(CONNECTOR_KINDS),
    entityId: Type.Optional(Nullable(Uuid)),
    mapping: Type.Optional(MappingSchema),
    delivery: Type.Optional(DeliverySchema),
    settings: Type.Optional(SettingsSchema),
    enabled: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export const ConnectorPatch = Type.Partial(Type.Omit(ConnectorBody, ['kind']), {
  additionalProperties: false,
});

export const ConnectorOut = Type.Object({
  id: Uuid,
  name: Type.String(),
  kind: Type.String(),
  availability: Type.String(),
  docs: Type.String(),
  entityId: Nullable(Type.String()),
  mapping: MappingSchema,
  delivery: DeliverySchema,
  settings: SettingsSchema,
  enabled: Type.Boolean(),
  credentials: Type.Array(Type.String()),
  configSha256: Type.String(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

export const CredentialsBody = Type.Object(
  {
    password: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    privateKey: Type.Optional(Type.String({ minLength: 1, maxLength: 16_384 })),
    passphrase: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    clientId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    clientSecret: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    refreshToken: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  },
  { additionalProperties: false },
);

export const PeriodBody = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 120 }),
    frequency: lit(['weekly', 'fortnightly', 'four_weekly', 'semi_monthly', 'monthly'] as const),
    startDate: CivilDate,
    endDate: CivilDate,
    payDate: Type.Optional(Nullable(CivilDate)),
    entityId: Type.Optional(Nullable(Uuid)),
  },
  { additionalProperties: false },
);
export const PeriodOut = Type.Object({
  id: Uuid,
  name: Type.String(),
  entityId: Nullable(Type.String()),
  frequency: Type.String(),
  startDate: Type.String(),
  endDate: Type.String(),
  payDate: Nullable(Type.String()),
  status: Type.String(),
  closedAt: Nullable(Type.String()),
  snapshotSha256: Nullable(Type.String()),
  counts: Nullable(Type.Record(Type.String(), Type.Integer())),
  createdAt: Type.String(),
});

export const ExportOut = Type.Object({
  id: Uuid,
  periodId: Uuid,
  connectorId: Uuid,
  fileName: Type.String(),
  contentType: Type.String(),
  sizeBytes: Type.Integer(),
  sha256: Type.String(),
  inputsSha256: Type.String(),
  configSha256: Type.String(),
  reproducible: Type.Boolean(),
  counts: Type.Record(Type.String(), Type.Integer()),
  createdAt: Type.String(),
});
export const DeliveryOut = Type.Object({
  id: Uuid,
  exportId: Uuid,
  connectorId: Uuid,
  periodId: Uuid,
  method: Type.String(),
  status: Type.String(),
  destination: Nullable(Type.String()),
  detail: Type.Record(Type.String(), Type.Any()),
  error: Nullable(Type.String()),
  attempts: Type.Integer(),
  createdAt: Type.String(),
  completedAt: Nullable(Type.String()),
});

const Row = Type.Record(Type.String(), Type.Any());
export const InputsOut = Type.Object({
  version: Type.Integer(),
  period: Row,
  employees: Type.Array(Row),
  hours: Type.Array(Row),
  absences: Type.Array(Row),
  sickPay: Type.Array(Row),
  payChanges: Type.Array(Row),
  starters: Type.Array(Row),
  leavers: Type.Array(Row),
});
