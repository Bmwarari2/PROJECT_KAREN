import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { apiCall, expectAccessible, lastMailTo, signUpAndEnrol } from './helpers';

/** Core HR flows in the browser, against the real API. Fictional data only. */

const magicLink = (text: string) => /(https?:\/\/\S+\/auth\/magic\?token=\S+)/.exec(text)![1]!;

async function seedEntity(page: Page) {
  return (
    await apiCall<{ id: string }>(page.request, 'POST', '/v1/org/legal-entities', {
      name: 'Fictional UK Ltd',
      country: 'GB',
      currency: 'GBP',
      timeZone: 'Europe/London',
    })
  ).id;
}

async function hire(page: Page, entityId: string, values: Record<string, unknown>) {
  const base = {
    startDate: '2026-01-05',
    entityId,
    jobTitle: 'Analyst',
    payAmountMinor: 4_000_000,
    payCurrency: 'GBP',
    payFrequency: 'annual',
    contractType: 'permanent',
  };
  return (await apiCall<{ id: string }>(page.request, 'POST', '/v1/employees', { ...base, ...values })).id;
}

test.describe('field-level permissions in the UI', () => {
  test('a manager opening a report’s profile sees the same fields the API allows: no pay, no date of birth', async ({
    page,
    browser,
  }) => {
    const { slug } = await signUpAndEnrol(page);
    const entity = await seedEntity(page);
    const managerEmail = `morgan.manager@${slug}.example.test`;
    const manager = await hire(page, entity, {
      legalFirstName: 'Morgan',
      legalLastName: 'Manager',
      jobTitle: 'Team lead',
      workEmail: managerEmail,
      payAmountMinor: 6_500_000,
    });
    const report = await hire(page, entity, {
      legalFirstName: 'Reese',
      legalLastName: 'Report',
      managerId: manager,
      dateOfBirth: '1990-02-03',
    });
    await apiCall(page.request, 'POST', `/v1/employees/${manager}/invite`, { roles: ['manager'] });

    // the owner sees pay and personal details
    await page.goto(`/app/people/${report}`);
    await expect(page.getByRole('heading', { level: 2, name: 'Reese Report' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Pay', exact: true })).toBeVisible();
    await expect(page.getByText('£40,000.00')).toBeVisible();
    await expect(page.getByText('Date of birth')).toBeVisible();
    // the people list exports exactly what the list shows (CSV here; Excel is the same rows)
    await page.goto('/app/people');
    const download = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Export CSV' }).click();
    const csv = readFileSync((await (await download).path())!, 'utf8');
    expect(csv.split('\r\n')[0]).toBe(
      'employeeNumber,displayName,jobTitle,department,location,country,status,startDate,workEmail',
    );
    expect(csv).toContain('"Reese Report"');

    // the manager signs in from their invitation email
    const context = await browser.newContext();
    const mp = await context.newPage();
    await mp.goto(magicLink((await lastMailTo(managerEmail)).text));
    await mp.waitForURL(/\/app$/);
    const viaApi = await (await mp.request.get(`/v1/employees/${report}`)).json();
    expect(viaApi.access).toMatchObject({ payAmountMinor: 'none', dateOfBirth: 'none', jobTitle: 'read' });
    expect(viaApi.employee.payAmountMinor).toBeUndefined();

    await mp.goto(`/app/people/${report}`);
    await expect(mp.getByRole('heading', { level: 2, name: 'Reese Report' })).toBeVisible();
    await expect(mp.getByRole('heading', { name: 'Job', exact: true })).toBeVisible();
    await expect(mp.getByText('Analyst').first()).toBeVisible();
    await expect(mp.getByRole('heading', { name: 'Pay', exact: true })).toHaveCount(0);
    await expect(mp.getByText('£40,000.00')).toHaveCount(0);
    await expect(mp.getByText('Date of birth')).toHaveCount(0);
    await expect(mp.getByRole('button', { name: 'Make a change' })).toHaveCount(0);
    await expect(mp.getByRole('link', { name: 'Export CSV' })).toHaveCount(0);
    await expectAccessible(mp);
    // and cannot open someone outside their team
    const outsider = await hire(page, entity, { legalFirstName: 'Outside', legalLastName: 'Team' });
    await mp.goto(`/app/people/${outsider}`);
    await expect(mp.getByRole('heading', { name: /not allowed|permission/i })).toBeVisible();
    await context.close();
  });
});

test.describe('org chart', () => {
  test('renders the first level and expands a node within the time budget, with search and focus', async ({
    page,
  }) => {
    await signUpAndEnrol(page);
    const entity = await seedEntity(page);
    const root = await hire(page, entity, {
      legalFirstName: 'Rowan',
      legalLastName: 'Root',
      jobTitle: 'Managing director',
    });
    for (let i = 1; i <= 8; i++) {
      const lead = await hire(page, entity, {
        legalFirstName: `Lead${i}`,
        legalLastName: 'Fictional',
        jobTitle: 'Head of team',
        managerId: root,
      });
      for (let j = 1; j <= 3; j++)
        await hire(page, entity, {
          legalFirstName: `Member${i}x${j}`,
          legalLastName: 'Fictional',
          managerId: lead,
        });
    }
    // warm-up load (compiles nothing in production, but primes the connection pool)
    await page.goto('/app/org-chart');
    await expect(page.getByRole('treeitem').first()).toBeVisible();

    const runs: Array<{ firstRenderMs: number; expandMs: number }> = [];
    for (let i = 0; i < 3; i++) {
      await page.goto('/app');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      runs.push(
        await page.evaluate(async () => {
          const waitFor = (pred: () => boolean) =>
            new Promise<void>((resolve, reject) => {
              const started = performance.now();
              const tick = () =>
                pred()
                  ? resolve()
                  : performance.now() - started > 10_000
                    ? reject(new Error('timeout'))
                    : requestAnimationFrame(tick);
              tick();
            });
          // in-app navigation to the org chart until the first level is on screen
          const link = [...document.querySelectorAll<HTMLAnchorElement>('a[href="/app/org-chart"]')].find(
            (a) => a.offsetParent !== null,
          )!;
          const t0 = performance.now();
          link.click();
          await waitFor(() => !!document.querySelector('[role="tree"] [role="treeitem"]'));
          const firstRenderMs = performance.now() - t0;
          // expanding a node until its children are rendered
          const button = document.querySelector<HTMLButtonElement>('[role="tree"] [role="treeitem"] button')!;
          const t1 = performance.now();
          button.click();
          await waitFor(() => document.querySelectorAll('[role="treeitem"][aria-level="2"]').length >= 8);
          return { firstRenderMs, expandMs: performance.now() - t1 };
        }),
      );
    }
    const median = (k: 'firstRenderMs' | 'expandMs') => runs.map((r) => r[k]).sort((a, b) => a - b)[1]!;
    const result = {
      at: new Date().toISOString(),
      people: 33,
      runs,
      medianFirstRenderMs: Math.round(median('firstRenderMs')),
      medianExpandMs: Math.round(median('expandMs')),
    };
    console.log(`org chart client timing: ${JSON.stringify(result)}`);
    // kept with the other benchmark results (git-ignored); Playwright clears its own output folder per run
    mkdirSync('../../.verify', { recursive: true });
    writeFileSync('../../.verify/org-chart-client-timing.json', JSON.stringify(result, null, 2));
    expect(result.medianFirstRenderMs).toBeLessThan(1000);
    expect(result.medianExpandMs).toBeLessThan(300);
    await expect(page.getByRole('link', { name: 'Lead1 Fictional' })).toBeVisible();
    await expectAccessible(page);

    // search and focus: the chain to the person is expanded and the person is selected
    await page.getByRole('searchbox', { name: 'Find a person' }).fill('Member5x2');
    await page.getByRole('button', { name: /Member5x2 Fictional/ }).click();
    await expect(page.locator('[role="treeitem"][aria-selected="true"]')).toContainText(
      'Member5x2 Fictional',
    );
    await expect(page.locator('[role="treeitem"][aria-selected="true"]')).toHaveAttribute('aria-level', '3');
  });
});

test.describe('pre-start portal', () => {
  test('a new joiner signs in before their start date to sign documents, complete forms and work through their checklist', async ({
    page,
    browser,
  }) => {
    const { slug } = await signUpAndEnrol(page);
    const entity = await seedEntity(page);
    const template = await apiCall<{ id: string }>(page.request, 'POST', '/v1/workflow-templates', {
      kind: 'onboarding',
      name: 'Joiner self-service',
      autoStart: false,
      tasks: [
        { key: 'photo', title: 'Upload a profile photo', assignee: { type: 'employee' }, dueOffsetDays: -7 },
        {
          key: 'handbook',
          title: 'Read the staff handbook',
          assignee: { type: 'employee' },
          dueOffsetDays: -2,
        },
      ],
    });
    const start = new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10);
    const joinerEmail = `nova.joiner@${slug}.example.test`;
    const joiner = await hire(page, entity, {
      startDate: start,
      legalFirstName: 'Nova',
      legalLastName: 'Joiner',
      jobTitle: 'Designer',
      personalEmail: joinerEmail,
    });
    const tpl = (
      await apiCall<{ id: string }>(page.request, 'POST', '/v1/document-templates', {
        name: 'Contract of employment',
        body: 'Dear {{employee.firstName}}, welcome to {{company.name}}.',
      })
    ).id;
    await apiCall(page.request, 'POST', `/v1/document-templates/${tpl}/generate`, {
      employeeId: joiner,
      requireSignature: true,
    });
    // (auto-start runs in the background worker, which the e2e stack does not run: start it explicitly)
    await apiCall(page.request, 'POST', '/v1/workflows', {
      templateId: template.id,
      employeeId: joiner,
      anchorDate: start,
    });
    const invited = await apiCall<{ tasksAssigned: number }>(
      page.request,
      'POST',
      `/v1/employees/${joiner}/invite`,
      {},
    );
    expect(invited.tasksAssigned).toBe(2);

    const context = await browser.newContext();
    const jp = await context.newPage();
    await jp.goto(magicLink((await lastMailTo(joinerEmail)).text));
    await jp.waitForURL(/\/app$/);
    // Home lists the onboarding among what needs the joiner's attention
    await jp.getByRole('link', { name: /Get ready for your first day/ }).click();
    await jp.waitForURL(/\/app\/welcome$/);
    await expect(
      jp.getByRole('heading', { level: 1, name: `Welcome to Fictional ${slug} Ltd, Nova` }),
    ).toBeVisible();
    await expect(jp.getByText(/Days until you start: 2[01]\b/)).toBeVisible();
    await expect(jp.getByText('0 of 5 steps complete')).toBeVisible();
    await expectAccessible(jp);

    // forms
    await jp.getByLabel('Personal phone').fill('+44 7700 900123');
    await jp.getByLabel('Address line 1').fill('1 Fictional Street');
    await jp.getByLabel(/^(Town or city|City)$/).fill('Leeds'); // en-GB / en-US wording
    await jp.getByLabel(/^(Postcode|ZIP code)$/).fill('LS1 1AA');
    await jp.getByLabel('Country code').fill('GB');
    await jp
      .locator('form')
      .filter({ has: jp.getByLabel('Personal phone') })
      .getByRole('button', { name: 'Save' })
      .click();
    await expect(jp.getByText('1 of 5 steps complete')).toBeVisible();
    await jp.getByLabel('Full name').fill('Orion Joiner');
    await jp.getByLabel('Relationship').fill('Parent');
    await jp.getByLabel('Phone number').fill('+44 7700 900456');
    await jp
      .locator('form')
      .filter({ has: jp.getByLabel('Full name') })
      .getByRole('button', { name: 'Save' })
      .click();
    await expect(jp.getByText('2 of 5 steps complete')).toBeVisible();

    // checklist
    await jp.getByRole('button', { name: 'Mark as done: Upload a profile photo' }).click();
    await expect(jp.getByText('3 of 5 steps complete')).toBeVisible();

    // sign the contract
    await jp.getByRole('link', { name: 'Sign Contract of employment' }).click();
    await jp.getByLabel('Type your full name').fill('Nova Joiner');
    await jp.getByLabel('I have read this document and agree to sign it electronically.').check();
    await jp.getByRole('button', { name: 'Sign document' }).click();
    await expect(jp.getByText('Document signed.', { exact: true })).toBeVisible();
    await jp.goto('/app/welcome');
    await expect(jp.getByText('4 of 5 steps complete')).toBeVisible();
    await expect(jp.getByText(/^Signed on /)).toBeVisible();
    await expectAccessible(jp);

    // without permission to view people, the directory says so and points to the org chart
    await jp.goto('/app/people');
    await expect(jp.getByRole('heading', { name: 'The directory isn’t part of your access' })).toBeVisible();
    await expect(
      jp.getByText('Opening the directory needs the “View people” permission.', { exact: false }),
    ).toBeVisible();
    await expect(jp.getByRole('link', { name: 'Open the org chart' })).toHaveAttribute(
      'href',
      '/app/org-chart',
    );
    await expectAccessible(jp);

    // HR sees the joiner's details from their start date
    const hr = await apiCall<{ employee: { personalPhone: string } }>(
      page.request,
      'GET',
      `/v1/employees/${joiner}?asOf=${start}`,
    );
    expect(hr.employee.personalPhone).toBe('+44 7700 900123');
    await context.close();
  });
});
