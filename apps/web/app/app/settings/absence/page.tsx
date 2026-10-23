'use client';
import * as React from 'react';
import { BellRing, Plus, Users } from 'lucide-react';
import { Badge, Button, EmptyState, Field, Input, Skeleton, Table, TD, TH, THead, TR } from '@thapsus/ui';
import { formatUnit } from '@thapsus/core/i18n';
import { api } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import {
  Checkbox,
  FormError,
  numberOrUndefined,
  PageHeader,
  RadioGroup,
  RoleSelect,
  selectClass,
  SettingsCard,
  useAction,
  useOrg,
  usePermission,
  useRoleName,
} from '../kit';
import { useSectionLevel } from '@/components/module-page';

interface Trigger {
  id: string;
  name: string;
  bradfordThreshold: number | null;
  spellsThreshold: number | null;
  windowDays: number;
  notifyRole: string;
  notifyManager: boolean;
}
interface CoverRule {
  id: string;
  name: string;
  departmentId: string | null;
  locationId: string | null;
  minPresent: number;
  enforcement: 'warn' | 'block';
}
interface AbsenceSettings {
  fitNoteAfterCalendarDays?: number;
  fmla?: { leaveYearMethod?: string; fixedYearStart?: string; publicAgency?: boolean };
}

function AbsencePolicy() {
  const t = useT();
  const settings = useApi<AbsenceSettings>('/v1/settings/absence');
  const fmlaRule = useApi<{ value: { leaveYearMethods?: string[] } }>('/v1/rules/US/family_leave.fmla');
  const action = useAction();
  const [fitNote, setFitNote] = React.useState<string | null>(null);
  const [method, setMethod] = React.useState<string | null>(null);
  const [publicAgency, setPublicAgency] = React.useState<boolean | null>(null);
  const [yearStart, setYearStart] = React.useState<string | null>(null);
  if (!settings.data) return <Skeleton className="h-40" />;
  const s = settings.data;
  const fitValue = fitNote ?? (s.fitNoteAfterCalendarDays ? String(s.fitNoteAfterCalendarDays) : '');
  const methodValue = method ?? s.fmla?.leaveYearMethod ?? '';
  const agencyValue = publicAgency ?? !!s.fmla?.publicAgency;
  const yearStartValue = yearStart ?? s.fmla?.fixedYearStart ?? '';
  const fixed = methodValue === 'fixed_12_month_period';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const body = {
      fitNoteAfterCalendarDays: numberOrUndefined(fitValue) ?? null,
      fmla: {
        ...(methodValue ? { leaveYearMethod: methodValue } : {}),
        ...(fixed && yearStartValue ? { fixedYearStart: yearStartValue } : {}),
        publicAgency: agencyValue,
      },
    };
    if (await action.run(() => api('/v1/settings/absence', { method: 'PUT', json: body }), t('admin.saved')))
      settings.reload();
  }

  return (
    <SettingsCard
      id="absence-policy"
      title={t('admin.absence.policyTitle')}
      description={t('admin.absence.policyBody')}
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field
          id="fit-note"
          label={t('admin.absence.fitNote')}
          hint={t('admin.absence.fitNoteHint')}
          className="sm:w-1/2"
        >
          {(p) => (
            <Input
              {...p}
              type="number"
              inputMode="numeric"
              min={1}
              max={365}
              step={1}
              value={fitValue}
              onChange={(e) => setFitNote(e.target.value)}
            />
          )}
        </Field>
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-callout font-semibold">{t('admin.absence.fmlaTitle')}</legend>
          <p className="text-footnote text-text-secondary">{t('admin.absence.fmlaBody')}</p>
          <Field id="fmla-method" label={t('admin.absence.fmlaMethod')} className="sm:w-1/2">
            {(p) => (
              <select
                {...p}
                className={selectClass}
                value={methodValue}
                onChange={(e) => setMethod(e.target.value)}
              >
                <option value="">{t('admin.absence.fmlaDefault')}</option>
                {(fmlaRule.data?.value.leaveYearMethods ?? []).map((m) => (
                  <option key={m} value={m}>
                    {t(`admin.absence.fmlaMethods.${m}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {fixed ? (
            <Field
              id="fmla-year-start"
              label={t('admin.absence.fmlaYearStart')}
              hint={t('admin.absence.fmlaYearStartHint')}
              className="sm:w-1/2"
            >
              {(p) => (
                <Input
                  {...p}
                  required
                  pattern="(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])"
                  inputMode="numeric"
                  maxLength={5}
                  value={yearStartValue}
                  onChange={(e) => setYearStart(e.target.value)}
                />
              )}
            </Field>
          ) : null}
          <Checkbox
            id="fmla-public"
            label={t('admin.absence.publicAgency')}
            hint={t('admin.absence.publicAgencyHint')}
            checked={agencyValue}
            onChange={setPublicAgency}
          />
        </fieldset>
        <FormError message={action.error} />
        <Button type="submit" className="self-start" loading={action.busy}>
          {t('common.save')}
        </Button>
      </form>
    </SettingsCard>
  );
}

function Triggers() {
  const t = useT();
  const sec = useSectionLevel();
  const locale = useLocale();
  const roleName = useRoleName();
  const triggers = useApi<Trigger[]>('/v1/absence/triggers');
  const action = useAction();
  const [v, setV] = React.useState({
    name: '',
    bradford: '',
    spells: '',
    windowDays: '365',
    notifyRole: 'hr_admin',
    notifyManager: true,
  });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const bradfordThreshold = numberOrUndefined(v.bradford);
    const spellsThreshold = numberOrUndefined(v.spells);
    if (bradfordThreshold === undefined && spellsThreshold === undefined) {
      action.setError(t('admin.absence.needsThreshold'));
      return;
    }
    const body = {
      name: v.name.trim(),
      bradfordThreshold,
      spellsThreshold,
      windowDays: Number(v.windowDays),
      notifyRole: v.notifyRole,
      notifyManager: v.notifyManager,
    };
    if (
      await action.run(
        () => api('/v1/absence/triggers', { method: 'POST', json: body }),
        t('admin.absence.triggerCreated'),
      )
    ) {
      setV({ ...v, name: '', bradford: '', spells: '' });
      triggers.reload();
    }
  }

  return (
    <SettingsCard
      id="absence-triggers"
      title={t('admin.absence.triggersTitle')}
      description={t('admin.absence.triggersBody')}
    >
      {!triggers.data ? (
        <Skeleton className="h-20" />
      ) : triggers.data.length === 0 ? (
        <EmptyState level={sec.level} icon={<BellRing aria-hidden />} title={t('admin.absence.noTriggers')} />
      ) : (
        <Table dense scrollLabel={t('admin.tableScroll', { name: t('admin.absence.triggersTitle') })}>
          <THead>
            <tr>
              <TH>{t('admin.name')}</TH>
              <TH>{t('admin.absence.threshold')}</TH>
              <TH>{t('admin.absence.window')}</TH>
              <TH>{t('admin.absence.notifies')}</TH>
            </tr>
          </THead>
          <tbody>
            {triggers.data.map((x) => (
              <TR key={x.id}>
                <TD className="font-semibold">{x.name}</TD>
                <TD>
                  {[
                    x.bradfordThreshold !== null
                      ? t('admin.absence.bradfordAtLeast', { n: x.bradfordThreshold })
                      : null,
                    x.spellsThreshold !== null
                      ? t('admin.absence.spellsAtLeast', { n: x.spellsThreshold })
                      : null,
                  ]
                    .filter(Boolean)
                    .join(t('admin.absence.or'))}
                </TD>
                <TD>{formatUnit(x.windowDays, 'day', locale)}</TD>
                <TD>
                  {x.notifyManager
                    ? t('admin.absence.roleAndManager', { role: roleName(x.notifyRole) })
                    : roleName(x.notifyRole)}
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
      )}
      <form onSubmit={submit} className="flex flex-col gap-4 border-t border-border pt-4">
        <sec.sub className="text-callout font-semibold">{t('admin.absence.addTrigger')}</sec.sub>
        <div className="grid gap-4 md:grid-cols-2">
          <Field id="trg-name" label={t('admin.name')}>
            {(p) => (
              <Input
                {...p}
                required
                maxLength={120}
                value={v.name}
                onChange={(e) => setV({ ...v, name: e.target.value })}
              />
            )}
          </Field>
          <Field id="trg-window" label={t('admin.absence.windowLabel')} hint={t('admin.absence.windowHint')}>
            {(p) => (
              <Input
                {...p}
                type="number"
                inputMode="numeric"
                required
                min={7}
                max={730}
                step={1}
                value={v.windowDays}
                onChange={(e) => setV({ ...v, windowDays: e.target.value })}
              />
            )}
          </Field>
          <Field id="trg-bradford" label={t('admin.absence.bradford')} hint={t('admin.absence.bradfordHint')}>
            {(p) => (
              <Input
                {...p}
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                value={v.bradford}
                onChange={(e) => setV({ ...v, bradford: e.target.value })}
              />
            )}
          </Field>
          <Field id="trg-spells" label={t('admin.absence.spells')} hint={t('admin.absence.spellsHint')}>
            {(p) => (
              <Input
                {...p}
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                value={v.spells}
                onChange={(e) => setV({ ...v, spells: e.target.value })}
              />
            )}
          </Field>
          <Field id="trg-role" label={t('admin.absence.notifyRole')}>
            {(p) => (
              <RoleSelect
                id={p.id}
                aria-describedby={p['aria-describedby']}
                value={v.notifyRole}
                onChange={(notifyRole) => setV({ ...v, notifyRole })}
              />
            )}
          </Field>
        </div>
        <Checkbox
          id="trg-manager"
          label={t('admin.absence.notifyManager')}
          checked={v.notifyManager}
          onChange={(notifyManager) => setV({ ...v, notifyManager })}
        />
        <FormError message={action.error} />
        <Button type="submit" className="self-start" loading={action.busy}>
          <Plus aria-hidden className="h-4 w-4 stroke-[1.5]" />
          {t('admin.absence.addTriggerButton')}
        </Button>
      </form>
    </SettingsCard>
  );
}

function CoverRules() {
  const t = useT();
  const sec = useSectionLevel();
  const rules = useApi<CoverRule[]>('/v1/leave/cover-rules');
  const departments = useOrg('departments');
  const locations = useOrg('locations');
  const action = useAction();
  const [v, setV] = React.useState({
    name: '',
    departmentId: '',
    locationId: '',
    minPresent: '1',
    enforcement: 'warn' as CoverRule['enforcement'],
  });
  const nameOf = (list: Array<{ id: string; name: string }> | undefined, id: string | null) =>
    id ? (list?.find((x) => x.id === id)?.name ?? '—') : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const body = {
      name: v.name.trim(),
      departmentId: v.departmentId || null,
      locationId: v.locationId || null,
      minPresent: Number(v.minPresent),
      enforcement: v.enforcement,
    };
    if (
      await action.run(
        () => api('/v1/leave/cover-rules', { method: 'POST', json: body }),
        t('admin.absence.coverCreated'),
      )
    ) {
      setV({ ...v, name: '' });
      rules.reload();
    }
  }

  return (
    <SettingsCard
      id="cover-rules"
      title={t('admin.absence.coverTitle')}
      description={t('admin.absence.coverBody')}
    >
      {!rules.data ? (
        <Skeleton className="h-20" />
      ) : rules.data.length === 0 ? (
        <EmptyState level={sec.level} icon={<Users aria-hidden />} title={t('admin.absence.noCover')} />
      ) : (
        <Table dense scrollLabel={t('admin.tableScroll', { name: t('admin.absence.coverTitle') })}>
          <THead>
            <tr>
              <TH>{t('admin.name')}</TH>
              <TH>{t('admin.absence.coverScope')}</TH>
              <TH className="text-right">{t('admin.absence.minPresent')}</TH>
              <TH>{t('admin.absence.enforcement')}</TH>
            </tr>
          </THead>
          <tbody>
            {rules.data.map((r) => (
              <TR key={r.id}>
                <TD className="font-semibold">{r.name}</TD>
                <TD>
                  {[nameOf(departments.data, r.departmentId), nameOf(locations.data, r.locationId)]
                    .filter(Boolean)
                    .join(' · ') || t('admin.leave.everyone')}
                </TD>
                <TD className="text-right">{r.minPresent}</TD>
                <TD>
                  {r.enforcement === 'block' ? (
                    <Badge tone="warning">{t('admin.absence.block')}</Badge>
                  ) : (
                    <Badge>{t('admin.absence.warn')}</Badge>
                  )}
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
      )}
      <form onSubmit={submit} className="flex flex-col gap-4 border-t border-border pt-4">
        <sec.sub className="text-callout font-semibold">{t('admin.absence.addCover')}</sec.sub>
        <div className="grid gap-4 md:grid-cols-2">
          <Field id="cover-name" label={t('admin.name')}>
            {(p) => (
              <Input
                {...p}
                required
                maxLength={120}
                value={v.name}
                onChange={(e) => setV({ ...v, name: e.target.value })}
              />
            )}
          </Field>
          <Field
            id="cover-min"
            label={t('admin.absence.minPresent')}
            hint={t('admin.absence.minPresentHint')}
          >
            {(p) => (
              <Input
                {...p}
                type="number"
                inputMode="numeric"
                required
                min={0}
                step={1}
                value={v.minPresent}
                onChange={(e) => setV({ ...v, minPresent: e.target.value })}
              />
            )}
          </Field>
          <Field id="cover-department" label={t('admin.absence.department')}>
            {(p) => (
              <select
                {...p}
                className={selectClass}
                value={v.departmentId}
                onChange={(e) => setV({ ...v, departmentId: e.target.value })}
              >
                <option value="">{t('admin.absence.allDepartments')}</option>
                {(departments.data ?? []).map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field id="cover-location" label={t('rota.location')}>
            {(p) => (
              <select
                {...p}
                className={selectClass}
                value={v.locationId}
                onChange={(e) => setV({ ...v, locationId: e.target.value })}
              >
                <option value="">{t('rota.allLocations')}</option>
                {(locations.data ?? []).map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        <RadioGroup
          name="cover-enforcement"
          legend={t('admin.absence.enforcement')}
          value={v.enforcement}
          onChange={(enforcement) => setV({ ...v, enforcement })}
          options={[
            { value: 'warn', label: t('admin.absence.warn'), hint: t('admin.absence.warnHint') },
            { value: 'block', label: t('admin.absence.block'), hint: t('admin.absence.blockHint') },
          ]}
        />
        <FormError message={action.error} />
        <Button type="submit" className="self-start" loading={action.busy}>
          <Plus aria-hidden className="h-4 w-4 stroke-[1.5]" />
          {t('admin.absence.addCoverButton')}
        </Button>
      </form>
    </SettingsCard>
  );
}

/** Absence policy, trigger alerts (Bradford Factor, number of spells) and minimum-cover rules. */
export default function AbsenceSettingsPage() {
  const t = useT();
  const has = usePermission();
  return (
    <>
      <PageHeader title={t('admin.section.absence.title')} lead={t('admin.absence.lead')} />
      {has('absence.manage') ? (
        <>
          <AbsencePolicy />
          <Triggers />
        </>
      ) : null}
      {has('leave.manage') ? <CoverRules /> : null}
    </>
  );
}
