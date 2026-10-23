import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, today } from '@thapsus/core/time';
import { closeDb, startTestApp, type TestContext } from './helpers';
import { phase6Company, type Phase6Company } from './phase6-fixtures';

/**
 * PROGRESS 6.5: asset register — assets with cost in integer minor units, assignment with a handover
 * sign-off given by the employee (timestamp, IP, statement version), and a return checklist tied to
 * offboarding (the offboarding workflow creates one return task per issued asset; recording the return
 * completes the task and, with the rest, the workflow).
 */
let ctx: TestContext;
let c: Phase6Company;
let employee: string;
let employeeCookie: string;
let colleagueCookie: string;
let hrCookie: string;
let laptop: string;
let assignment: string;

beforeAll(async () => {
  ctx = await startTestApp({ listen: false });
  ctx.clock.now = new Date('2026-09-01T09:15:00Z'); // injected time: the sign-off timestamp comes from deps.now()
  c = await phase6Company(ctx);
  employee = await c.hire({ legalFirstName: 'Ari', legalLastName: 'Asset' });
  employeeCookie = await c.login(employee);
  colleagueCookie = await c.login(await c.hire());
  hrCookie = await c.login(await c.hire(), 'hr_admin');
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

describe('asset register', () => {
  it('records assets with cost in minor units and a default return checklist per type', async () => {
    expect(
      (
        await c.api('POST', '/v1/assets', {
          assetTag: 'LT-0001',
          type: 'laptop',
          name: 'Fictional Book 14',
          costMinor: 129_999,
        })
      ).statusCode,
    ).toBe(400); // cost needs its currency
    const r = await c.api('POST', '/v1/assets', {
      assetTag: 'LT-0001',
      type: 'laptop',
      name: 'Fictional Book 14',
      serialNumber: 'FB14-000123',
      costMinor: 129_999,
      currency: 'GBP',
      purchasedOn: '2026-01-15',
      entityId: c.entity,
    });
    expect(r.statusCode, r.body).toBe(201);
    laptop = r.json().id;
    expect(r.json()).toMatchObject({
      status: 'in_stock',
      costMinor: 129_999,
      currency: 'GBP',
      holder: null,
      returnChecklist: [{ key: 'device' }, { key: 'charger' }, { key: 'dataWiped' }],
    });
    expect(
      (await c.api('POST', '/v1/assets', { assetTag: 'LT-0001', type: 'laptop', name: 'Duplicate tag' }))
        .statusCode,
    ).toBe(409);
    expect(
      (await c.api('POST', '/v1/assets', { assetTag: 'X1', type: 'phone', name: 'x' }, employeeCookie))
        .statusCode,
    ).toBe(403);
    expect(
      (await c.api('GET', '/v1/assets?q=FB14', undefined, hrCookie)).json().map((a: { id: string }) => a.id),
    ).toEqual([laptop]);
  });

  it('assigns an asset to an employee and asks them to acknowledge the handover', async () => {
    const r = await c.api(
      'POST',
      `/v1/assets/${laptop}/assign`,
      {
        employeeId: employee,
        assignedOn: '2026-09-01',
        conditionOut: 'New in box',
        handoverNote: 'Includes charger',
      },
      hrCookie,
    );
    expect(r.statusCode, r.body).toBe(201);
    assignment = r.json().id;
    expect(r.json()).toMatchObject({
      status: 'active',
      employeeId: employee,
      acknowledgedAt: null,
      assetTag: 'LT-0001',
    });
    expect((await c.api('GET', `/v1/assets/${laptop}`, undefined, hrCookie)).json()).toMatchObject({
      status: 'assigned',
      holder: { employeeId: employee, acknowledgedAt: null },
    });
    expect(
      (
        await c.api(
          'POST',
          `/v1/assets/${laptop}/assign`,
          { employeeId: employee, assignedOn: '2026-09-02' },
          hrCookie,
        )
      ).statusCode,
    ).toBe(409);
    const tasks = (await c.api('GET', '/v1/tasks', undefined, employeeCookie)).json();
    expect(tasks.find((t: { link: string }) => t.link === `/app/assets?ack=${assignment}`)).toMatchObject({
      title: 'Confirm you received Fictional Book 14',
      status: 'open',
    });
    const note = await c.tx((t) =>
      t.one<{ title_key: string; params: { asset: string } }>(
        `SELECT title_key, params FROM app.notifications WHERE kind = 'asset.assigned'`,
      ),
    );
    expect(note).toEqual({ title_key: 'notify.assetAssigned', params: { asset: 'Fictional Book 14' } });
    const mine = (await c.api('GET', '/v1/me/assets', undefined, employeeCookie)).json();
    expect(mine.map((a: { id: string }) => a.id)).toEqual([assignment]);
    expect((await c.api('GET', '/v1/me/assets', undefined, colleagueCookie)).json()).toEqual([]);
  });

  it('only the employee can sign for the handover; the sign-off records who, when and which statement', async () => {
    expect(
      (
        await c.api(
          'POST',
          `/v1/asset-assignments/${assignment}/acknowledge`,
          { confirm: true },
          colleagueCookie,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (await c.api('POST', `/v1/asset-assignments/${assignment}/acknowledge`, { confirm: true }, hrCookie))
        .statusCode,
    ).toBe(404);
    const r = await c.api(
      'POST',
      `/v1/asset-assignments/${assignment}/acknowledge`,
      { confirm: true },
      employeeCookie,
      { 'user-agent': 'FictionalBrowser/1.0' },
    );
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({
      acknowledgedAt: '2026-09-01T09:15:00.000Z',
      acknowledgementStatement: 'assets.ackStatement.v1',
    });
    const row = await c.tx((t) =>
      t.one<{ acknowledged_by: string; acknowledged_ip: string | null; acknowledged_user_agent: string }>(
        'SELECT acknowledged_by, acknowledged_ip, acknowledged_user_agent FROM app.asset_assignments WHERE id = $1',
        [assignment],
      ),
    );
    expect(row.acknowledged_ip).toMatch(/^10\./);
    expect(row.acknowledged_user_agent).toBe('FictionalBrowser/1.0');
    expect(
      (
        await c.api(
          'POST',
          `/v1/asset-assignments/${assignment}/acknowledge`,
          { confirm: true },
          employeeCookie,
        )
      ).statusCode,
    ).toBe(409);
    const task = await c.tx((t) =>
      t.one<{ status: string }>(`SELECT status FROM app.tasks WHERE dedupe_key = $1`, [
        `asset-ack:${assignment}`,
      ]),
    );
    expect(task.status).toBe('done');
    const audit = await c.tx((t) =>
      t.one<{ actor_id: string; diff: { acknowledgedAt: string } }>(
        `SELECT actor_id, diff FROM audit.events WHERE action = 'asset.acknowledged'`,
      ),
    );
    expect(audit.diff.acknowledgedAt).toBe('2026-09-01T09:15:00.000Z');
  });
});

describe('return checklist tied to offboarding', () => {
  let instance: string;
  let returnTask: string;

  it('starting the offboarding workflow creates one return task per issued asset', async () => {
    const tpl = await c.api('POST', '/v1/workflow-templates', {
      kind: 'offboarding',
      name: 'Leaver checklist',
      tasks: [
        {
          key: 'exit_interview',
          title: 'Exit interview',
          assignee: { type: 'role', value: 'hr_admin' },
          dueOffsetDays: 0,
        },
      ],
    });
    expect(tpl.statusCode, tpl.body).toBe(201);
    const phone = (
      await c.api('POST', '/v1/assets', {
        assetTag: 'PH-0042',
        type: 'phone',
        name: 'Fictional Phone 9',
        costMinor: 49_900,
        currency: 'GBP',
      })
    ).json().id;
    await c.api('POST', `/v1/assets/${phone}/assign`, { employeeId: employee, assignedOn: '2026-09-01' });
    const end = addDays(today('Europe/London'), 14);
    expect(
      (
        await c.api('POST', `/v1/employees/${employee}/terminate`, {
          endDate: end,
          reason: 'Fictional resignation',
        })
      ).statusCode,
    ).toBe(200);
    await c.drain();
    const wf = await c.tx((t) =>
      t.one<{ id: string }>(
        `SELECT id FROM app.workflow_instances WHERE employee_id = $1 AND kind = 'offboarding'`,
        [employee],
      ),
    );
    instance = wf.id;
    const tasks = await c.tx((t) =>
      t.query<{
        id: string;
        title: string;
        assignee_role: string;
        due_on: string;
        link: string;
        source: string;
      }>(
        `SELECT id, title, assignee_role, due_on, link, source FROM app.tasks WHERE source_id = $1 ORDER BY title`,
        [instance],
      ),
    );
    expect(tasks.map((t) => t.title)).toEqual([
      'Exit interview',
      'Return Fictional Book 14 (LT-0001)',
      'Return Fictional Phone 9 (PH-0042)',
    ]);
    const laptopTask = tasks.find((t) => t.title.includes('LT-0001'))!;
    expect(laptopTask).toMatchObject({
      assignee_role: 'hr_admin',
      due_on: end,
      link: `/app/assets?return=${assignment}`,
      source: 'workflow',
    });
    returnTask = laptopTask.id;
    expect(
      (await c.api('GET', `/v1/asset-assignments?employeeId=${employee}&status=active`, undefined, hrCookie))
        .json()
        .find((a: { id: string }) => a.id === assignment),
    ).toMatchObject({ returnTaskId: returnTask, returnRequestedOn: end });
    // HR sees the return tasks in their queue
    expect(
      (await c.api('GET', '/v1/tasks', undefined, hrCookie)).json().map((t: { id: string }) => t.id),
    ).toContain(returnTask);
    // starting the same workflow again does not duplicate them
    await c.api('POST', '/v1/workflows', {
      templateId: tpl.json().id,
      employeeId: employee,
      anchorDate: end,
    });
    expect(
      await c.tx((t) =>
        t.query(`SELECT 1 FROM app.tasks WHERE dedupe_key = $1`, [`asset-return:${assignment}`]),
      ),
    ).toHaveLength(1);
  });

  it('a return needs every checklist item; recording it completes the return task and frees the asset', async () => {
    const partial = await c.api(
      'POST',
      `/v1/asset-assignments/${assignment}/return`,
      {
        returnedOn: '2026-09-20',
        checklist: [
          { key: 'device', done: true },
          { key: 'charger', done: true },
        ],
      },
      hrCookie,
    );
    expect(partial.statusCode).toBe(422);
    expect(partial.json().missing).toEqual(['dataWiped']);
    expect(
      (
        await c.api(
          'POST',
          `/v1/asset-assignments/${assignment}/return`,
          { returnedOn: '2026-09-20', checklist: [{ key: 'device', done: true }] },
          employeeCookie,
        )
      ).statusCode,
    ).toBe(403);
    const ok = await c.api(
      'POST',
      `/v1/asset-assignments/${assignment}/return`,
      {
        returnedOn: '2026-09-20',
        conditionIn: 'Good',
        checklist: [
          { key: 'device', done: true },
          { key: 'charger', done: true },
          { key: 'dataWiped', done: true },
        ],
      },
      hrCookie,
    );
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({
      status: 'returned',
      returnedOn: '2026-09-20',
      checklist: [
        { key: 'device', done: true },
        { key: 'charger', done: true },
        { key: 'dataWiped', done: true },
      ],
    });
    expect(
      (
        await c.tx((t) =>
          t.one<{ status: string }>('SELECT status FROM app.tasks WHERE id = $1', [returnTask]),
        )
      ).status,
    ).toBe('done');
    expect((await c.api('GET', `/v1/assets/${laptop}`, undefined, hrCookie)).json()).toMatchObject({
      status: 'in_stock',
      holder: null,
    });
    expect(
      (
        await c.api(
          'POST',
          `/v1/asset-assignments/${assignment}/return`,
          { returnedOn: '2026-09-21', checklist: [] },
          hrCookie,
        )
      ).statusCode,
    ).toBe(409);
  });

  it('a lost asset closes its task too, and the offboarding workflow completes when everything is done', async () => {
    const phoneAssignment = (
      await c.api('GET', `/v1/asset-assignments?employeeId=${employee}&status=active`, undefined, hrCookie)
    ).json()[0];
    const r = await c.api(
      'POST',
      `/v1/asset-assignments/${phoneAssignment.id}/return`,
      { returnedOn: '2026-09-20', outcome: 'lost', checklist: [] },
      hrCookie,
    );
    expect(r.statusCode, r.body).toBe(200);
    expect(
      (await c.api('GET', `/v1/assets/${phoneAssignment.assetId}`, undefined, hrCookie)).json().status,
    ).toBe('lost');
    expect(
      (
        await c.tx((t) =>
          t.one<{ status: string }>('SELECT status FROM app.workflow_instances WHERE id = $1', [instance]),
        )
      ).status,
    ).toBe('active');
    const exit = await c.tx((t) =>
      t.one<{ id: string }>(`SELECT id FROM app.tasks WHERE source_id = $1 AND title = 'Exit interview'`, [
        instance,
      ]),
    );
    expect((await c.api('POST', `/v1/tasks/${exit.id}/complete`, undefined, hrCookie)).statusCode).toBe(200);
    expect(
      (
        await c.tx((t) =>
          t.one<{ status: string }>('SELECT status FROM app.workflow_instances WHERE id = $1', [instance]),
        )
      ).status,
    ).toBe('completed');
    const history = (await c.api('GET', `/v1/assets/${laptop}`, undefined, hrCookie)).json().assignments;
    expect(history).toHaveLength(1);
    const audits = await c.tx((t) =>
      t.query<{ action: string }>(`SELECT DISTINCT action FROM audit.events WHERE action LIKE 'asset.%'`),
    );
    expect(audits.map((a) => a.action).sort()).toEqual([
      'asset.acknowledged',
      'asset.assigned',
      'asset.created',
      'asset.lost',
      'asset.returned',
    ]);
  });
});
