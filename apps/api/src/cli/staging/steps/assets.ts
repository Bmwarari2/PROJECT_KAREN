import { t } from '@thapsus/core/i18n';
import { addDays, maxDate } from '@thapsus/core/time';
import { createTask, notify } from '../../../lib/notify';
import { insertRows, seedUuid, type SeedCtx } from '../context';
import { currentJob, locationOf, type PlanPerson } from '../plan';

type AssetType = 'laptop' | 'phone' | 'access_card' | 'headset' | 'monitor' | 'peripheral' | 'vehicle';
const COST: Record<AssetType, [name: string, gbpMinor: number]> = {
  laptop: ['Laptop 14-inch (fictional model K14)', 129_900],
  phone: ['Smartphone (fictional model P8)', 69_900],
  access_card: ['Site access card', 800],
  headset: ['Noise-cancelling headset', 14_900],
  monitor: ['27-inch monitor', 24_900],
  peripheral: ['Handheld barcode scanner', 45_000],
  vehicle: ['Delivery van (fictional fleet)', 3_450_000],
};
const FX: Record<string, number> = { GBP: 1, EUR: 1.15, USD: 1.3 };
const CHECKLIST: Partial<Record<AssetType, Array<{ key: string; label: string }>>> = {
  laptop: [
    { key: 'charger', label: 'Charger returned' },
    { key: 'wiped', label: 'Data wiped' },
  ],
  phone: [
    { key: 'sim', label: 'SIM removed' },
    { key: 'wiped', label: 'Factory reset' },
  ],
  vehicle: [
    { key: 'keys', label: 'Both keys returned' },
    { key: 'damage', label: 'Damage check done' },
  ],
};
const ACK = 'I confirm I have received this equipment in working order and will look after it.';

/**
 * Asset register: laptops for office staff, phones for managers, scanners and site cards in the warehouse,
 * vans for the drivers, plus stock, repairs, retired and lost items. Assignments carry the employee's
 * hand-over sign-off; leavers' assets were returned against the checklist; the employee login has one
 * new item to acknowledge (task and notification, as the assets route creates them).
 */
export async function seedAssets(ctx: SeedCtx) {
  const { tx, plan, ids, anchor } = ctx;
  const assets: Array<Record<string, unknown>> = [];
  const assignments: Array<Record<string, unknown>> = [];
  let tag = 0;
  const addAsset = (
    type: AssetType,
    p: PlanPerson | null,
    status: string,
    purchasedOn: string,
    entity: string,
    locKey: string,
    notes?: string,
  ) => {
    const [name, gbp] = COST[type];
    const currency = entity === 'ie' ? 'EUR' : entity === 'us' ? 'USD' : 'GBP';
    const n = ++tag;
    const id = seedUuid('asset', n);
    typeOf.set(id, type);
    const prefix = {
      laptop: 'LT',
      phone: 'PH',
      access_card: 'AC',
      headset: 'HS',
      monitor: 'MN',
      peripheral: 'SC',
      vehicle: 'VN',
    }[type];
    assets.push({
      id,
      asset_tag: `KST-${prefix}-${String(n).padStart(4, '0')}`,
      type,
      name,
      serial_number: type === 'access_card' ? null : `FX${prefix}${String(100000 + n * 37)}`,
      cost_minor: Math.round((gbp * FX[currency]!) / 100) * 100,
      currency,
      purchased_on: purchasedOn,
      status,
      entity_id: ids.entity[entity as 'uk'],
      location_id: ids.location[locKey as 'LON'],
      notes: notes ?? null,
      return_checklist: CHECKLIST[type] ?? [],
    });
    return id;
  };
  const typeOf = new Map<string, AssetType>();
  const assign = (
    assetId: string,
    p: PlanPerson,
    on: string,
    opts: { returned?: string; ack?: boolean } = {},
  ) => {
    const row = {
      id: seedUuid('asset-assignment', `${assetId}:${p.number}`),
      asset_id: assetId,
      employee_id: ids.employee[p.idx],
      assigned_on: on,
      due_back_on: null,
      condition_out: 'Good',
      handover_note: null,
      status: opts.returned ? 'returned' : 'active',
      acknowledged_at: opts.ack === false ? null : `${on}T10:30:00Z`,
      acknowledged_by: opts.ack === false ? null : p.login ? ids.user[p.login] : null,
      acknowledgement_statement: opts.ack === false ? null : ACK,
      returned_on: opts.returned ?? null,
      returned_at: opts.returned ? `${opts.returned}T16:00:00Z` : null,
      condition_in: opts.returned ? 'Good, normal wear' : null,
      received_by: opts.returned ? ids.user.hr_admin : null,
      checklist: opts.returned
        ? (CHECKLIST[typeOf.get(assetId)!] ?? []).map((c) => ({ ...c, done: true }))
        : [],
      created_at: `${on}T09:00:00Z`,
    };
    assignments.push(row);
    return row;
  };
  for (const p of plan.people) {
    if (p.kind === 'upcoming_starter') continue;
    const j = currentJob(p, p.endDate ?? anchor);
    const loc = locationOf(j.location);
    const on = maxDate(p.startDate, addDays(anchor, -1400));
    const office = !j.hourly && !['Logistics coordinator'].includes(j.title);
    const returned = p.kind === 'past_leaver' ? p.endDate! : undefined;
    if (office || p.level !== 'member') {
      const id = addAsset(
        'laptop',
        p,
        returned ? 'in_stock' : 'assigned',
        addDays(on, -10),
        p.entity,
        loc.key,
      );
      assign(id, p, on, { returned });
    }
    if (p.level !== 'member') {
      const id = addAsset(
        'phone',
        p,
        returned ? 'in_stock' : 'assigned',
        addDays(on, -10),
        p.entity,
        loc.key,
      );
      assign(id, p, on, { returned });
    }
    if (loc.key === 'MAN') {
      const id = addAsset(
        'access_card',
        p,
        returned ? 'retired' : 'assigned',
        addDays(on, -3),
        p.entity,
        loc.key,
      );
      assign(id, p, on, { returned });
      if (
        ['Warehouse operative', 'Goods-in operative', 'Inventory controller'].includes(j.title) &&
        !p.casual
      ) {
        const s = addAsset(
          'peripheral',
          p,
          returned ? 'in_stock' : 'assigned',
          addDays(on, -30),
          p.entity,
          loc.key,
        );
        assign(s, p, on, { returned });
      }
      if (j.title === 'Delivery driver') {
        const v = addAsset('vehicle', p, returned ? 'in_stock' : 'assigned', '2023-03-01', p.entity, loc.key);
        assign(v, p, maxDate(on, '2023-03-01'), { returned });
      }
    }
    if (p.dept === 'support' && !returned) {
      const h = addAsset('headset', p, 'assigned', addDays(on, -10), p.entity, loc.key);
      assign(h, p, on);
    }
  }
  // stock, repairs, retired and lost equipment
  for (let i = 0; i < 8; i++)
    addAsset('laptop', null, 'in_stock', addDays(anchor, -40), 'uk', 'LON', 'Ready for new joiners');
  for (let i = 0; i < 4; i++) addAsset('monitor', null, 'in_stock', addDays(anchor, -300), 'uk', 'LON');
  addAsset('laptop', null, 'in_repair', addDays(anchor, -700), 'uk', 'EDI', 'Keyboard replacement');
  addAsset('peripheral', null, 'in_repair', addDays(anchor, -500), 'uk', 'MAN', 'Cracked screen');
  addAsset('laptop', null, 'retired', '2019-06-01', 'uk', 'LON', 'End of life');
  addAsset('phone', null, 'lost', addDays(anchor, -400), 'uk', 'MAN', 'Reported lost on a delivery round');
  // the employee login was issued a new headset and has not signed for it yet
  const emp = plan.people[plan.logins.employee]!;
  const newOne = addAsset('headset', emp, 'assigned', addDays(anchor, -6), 'uk', 'MAN');
  const pending = assign(newOne, emp, addDays(anchor, -2), { ack: false });
  await insertRows(tx, 'app.assets', assets, { json: ['return_checklist'] });
  await insertRows(tx, 'app.asset_assignments', assignments, { json: ['checklist'] });
  const user = ids.user.employee;
  const title = t('en-GB', 'assets.ackTaskTitle', { asset: COST.headset[0] });
  const taskId = await createTask(tx, {
    source: 'manual',
    sourceId: String(pending.id),
    title,
    subjectEmployeeId: ids.employee[emp.idx],
    assigneeUserId: user,
    link: `/app/assets?ack=${pending.id}`,
    dedupeKey: `asset-ack:${pending.id}`,
  });
  await tx.exec('UPDATE app.asset_assignments SET acknowledgement_task_id = $2 WHERE id = $1', [
    pending.id,
    taskId ?? null,
  ]);
  await notify(tx, {
    userIds: [user],
    kind: 'asset.assigned',
    titleKey: 'notify.assetAssigned',
    params: { asset: COST.headset[0] },
    link: `/app/assets?ack=${pending.id}`,
    dedupeKey: `asset-assigned:${pending.id}`,
  });
  ctx.counts.assets = assets.length;
  ctx.counts.assetAssignments = assignments.length;
}
