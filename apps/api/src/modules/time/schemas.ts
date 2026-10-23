import { Type } from 'typebox';
import { Nullable, Uuid } from '../../http/schemas';

export const HHMM = Type.String({ pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' });
export const Zone = Type.String({ minLength: 1, maxLength: 64 });
export const Country = Type.String({ pattern: '^[A-Z]{2}$' });

/** A working-time or policy finding (rule key, date, numbers and the official source where it is statutory). */
export const Finding = Type.Object({
  rule: Type.String(),
  date: Type.Optional(Type.String()),
  detail: Type.Record(Type.String(), Type.Union([Type.Number(), Type.String()])),
  source: Type.Optional(Type.String()),
});

export const Shift = Type.Object({
  id: Uuid,
  employeeId: Nullable(Uuid),
  employeeName: Nullable(Type.String()),
  date: Type.String(),
  start: Type.String(),
  end: Type.String(),
  startLocal: Type.String(),
  endLocal: Type.String(),
  zone: Type.String(),
  startsAt: Type.String(),
  endsAt: Type.String(),
  breakMinutes: Type.Integer(),
  status: Type.String(),
  locationId: Nullable(Uuid),
  departmentId: Nullable(Uuid),
  role: Nullable(Type.String()),
  notes: Nullable(Type.String()),
  publishedAt: Nullable(Type.String()),
});

export interface ShiftDbRow {
  id: string;
  employee_id: string | null;
  display_name?: string | null;
  shift_date: string;
  start_local: string;
  end_local: string;
  zone: string;
  starts_at: string;
  ends_at: string;
  break_minutes: number;
  status: string;
  location_id: string | null;
  department_id: string | null;
  role: string | null;
  notes: string | null;
  published_at: string | null;
}

export const shiftOut = (s: ShiftDbRow) => ({
  id: s.id,
  employeeId: s.employee_id,
  employeeName: s.display_name ?? null,
  date: s.shift_date,
  start: s.start_local.slice(11),
  end: s.end_local.slice(11),
  startLocal: s.start_local,
  endLocal: s.end_local,
  zone: s.zone,
  startsAt: s.starts_at,
  endsAt: s.ends_at,
  breakMinutes: s.break_minutes,
  status: s.status,
  locationId: s.location_id,
  departmentId: s.department_id,
  role: s.role,
  notes: s.notes,
  publishedAt: s.published_at,
});

export const SHIFT_COLUMNS =
  's.id, s.employee_id, s.shift_date, s.start_local, s.end_local, s.zone, s.starts_at, s.ends_at, s.break_minutes, s.status, s.location_id, s.department_id, s.role, s.notes, s.published_at';

export const Slot = Type.Object({
  weekday: Type.Integer({ minimum: 1, maximum: 7 }),
  start: HHMM,
  end: HHMM,
  breakMinutes: Type.Optional(Type.Integer({ minimum: 0, maximum: 480 })),
  role: Type.Optional(Type.String({ maxLength: 80 })),
  headcount: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  employeeId: Type.Optional(Nullable(Uuid)),
});

export const Template = Type.Object({
  id: Uuid,
  name: Type.String(),
  locationId: Nullable(Uuid),
  departmentId: Nullable(Uuid),
  slots: Type.Array(Slot),
});

export const Swap = Type.Object({
  id: Uuid,
  kind: Type.String(),
  status: Type.String(),
  shiftId: Uuid,
  toShiftId: Nullable(Uuid),
  fromEmployeeId: Uuid,
  fromEmployeeName: Nullable(Type.String()),
  toEmployeeId: Nullable(Uuid),
  toEmployeeName: Nullable(Type.String()),
  acceptedAt: Nullable(Type.String()),
  approvalRequestId: Nullable(Uuid),
  shift: Shift,
  note: Nullable(Type.String()),
  createdAt: Type.String(),
});

export const ClockEventIn = Type.Object({
  clientEventId: Type.String({ minLength: 8, maxLength: 80, pattern: '^[A-Za-z0-9:_-]+$' }),
  kind: Type.Union([
    Type.Literal('in'),
    Type.Literal('out'),
    Type.Literal('break_start'),
    Type.Literal('break_end'),
  ]),
  occurredAt: Type.String({ format: 'date-time' }),
  zone: Type.Optional(Zone),
  location: Type.Optional(
    Type.Object({
      lat: Type.Number({ minimum: -90, maximum: 90 }),
      lng: Type.Number({ minimum: -180, maximum: 180 }),
      accuracyMetres: Type.Optional(Type.Number({ minimum: 0 })),
    }),
  ),
});

export const TimeSettingsSchema = Type.Object({
  enforcement: Type.Union([Type.Literal('warn'), Type.Literal('block')]),
  workweekStartsOn: Type.Integer({ minimum: 1, maximum: 7 }),
  geofence: Type.Object({
    countries: Type.Array(Country, { maxItems: 60 }),
    notice: Type.Record(Type.String(), Type.Record(Type.String(), Type.String({ maxLength: 2000 }))),
  }),
  kiosk: Type.Object({
    maxFailedAttempts: Type.Integer({ minimum: 3, maximum: 20 }),
    lockoutMinutes: Type.Integer({ minimum: 1, maximum: 1440 }),
    attemptsPerMinute: Type.Integer({ minimum: 5, maximum: 600 }),
  }),
  clock: Type.Object({ maxOfflineHours: Type.Integer({ minimum: 1, maximum: 720 }) }),
  timesheets: Type.Object({ varianceToleranceMinutes: Type.Integer({ minimum: 0, maximum: 240 }) }),
});

export const TimesheetDay = Type.Object({
  date: Type.String(),
  workedMinutes: Type.Integer(),
  scheduledMinutes: Type.Integer(),
  varianceMinutes: Type.Integer(),
  flagged: Type.Boolean(),
});

export const TimesheetOut = Type.Object({
  id: Nullable(Uuid),
  status: Type.String(),
  approvalRequestId: Nullable(Uuid),
  employeeId: Uuid,
  employeeNumber: Type.String(),
  employeeName: Type.String(),
  weekStart: Type.String(),
  days: Type.Array(TimesheetDay),
  workedMinutes: Type.Integer(),
  scheduledMinutes: Type.Integer(),
  regularMinutes: Type.Integer(),
  overtimeMinutes: Type.Integer(),
  doubleMinutes: Type.Integer(),
  violations: Type.Array(Finding),
  timeRecordingRequired: Type.Boolean(),
  timeRecordingJurisdiction: Nullable(Type.String()),
  optedOut: Type.Boolean(),
  openClock: Type.Boolean(),
  anomalies: Type.Integer(),
  outsideGeofence: Type.Integer(),
  sources: Type.Array(Type.String()),
  submittedAt: Nullable(Type.String()),
  decidedAt: Nullable(Type.String()),
  exportedAt: Nullable(Type.String()),
});
