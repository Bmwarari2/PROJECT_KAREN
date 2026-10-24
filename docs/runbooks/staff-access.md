# Runbook: Thapsus staff access to the back office

Thapsus staff sign in to the back office only with a **passkey or a hardware security key** (WebAuthn with user verification). There are no staff passwords and no authenticator-app codes. Nobody holds standing access to super-admin actions, rule publishing or a customer's support grant: those need a **time-boxed elevation** approved by a second staff member. Decisions: [ADR-0173 and ADR-0174](../DECISIONS.md). Security controls: [SECURITY.md](../SECURITY.md).

## 1. Who can do what

| Action                                                                          | Who                                                                                                | How                                               |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Create a staff account and its first enrolment link                             | An operator with the cell's back-office database credentials                                       | `create-staff` CLI (section 2)                    |
| Give an existing staff member a new enrolment link (another key, or a lost key) | The same operator                                                                                  | `staff-enrolment-link` CLI (section 3)            |
| Invite the first staff member on Google Cloud staging                           | The deploy workflow, after the owner approved it                                                   | `thapsus-stg-<cell>-staff-invite` job (section 5) |
| Approve an elevation                                                            | Another active staff member whose role may hold that scope, after re-authenticating with their key | Back office → **Access**                          |

Nobody can approve their own elevation (the database refuses it too), and support staff cannot grant themselves access to a customer: the customer grants support access in their own settings, and using it also needs a `support_grant` elevation.

## 2. Create a staff account (bootstrap)

Run on a machine that can reach the cell's database, with the cell's environment (the same variables as the API: `BACKOFFICE_DATABASE_URL` or `BACKOFFICE_DATABASE_SECRET` and `DATABASE_HOST`, `APP_BASE_URL`, optionally `BACKOFFICE_BASE_URL`):

```sh
pnpm --filter @thapsus/api exec tsx src/cli/create-staff.ts <email> "<name>" <super_admin|support|rules_editor|billing>
```

It prints `enrolment link (one use, valid 2 hours): https://…/backoffice/enrol#token=…`.

1. Send the link to the staff member over a channel you trust (in person, or an end-to-end encrypted message). Never by plain email to a personal address.
2. They open it **on the device that holds the key** (a phone with Face ID or Touch ID, a laptop with Windows Hello or Touch ID, or with a FIDO2 security key plugged in), optionally name the key, and choose **Register key**.
3. They are signed in. From then on they use **Sign in with a passkey or security key** at `/backoffice/signin`.

The link's token is stored only as a SHA-256 hash, works once, and only the newest link for a person works. The token travels in the URL fragment (`#token=`), so it never reaches a server log.

## 3. A new link for an existing staff member

```sh
pnpm --filter @thapsus/api exec tsx src/cli/staff-enrolment-link.ts <email>               # add another key
pnpm --filter @thapsus/api exec tsx src/cli/staff-enrolment-link.ts <email> --reset-keys  # lost or stolen key
```

`--reset-keys` removes every key the person registered and ends their sessions before printing the link. Use it when a device is lost, then confirm the person's identity out of band before you hand over the link.

To remove someone's access entirely, set `active = false` on their row in `backoffice.staff_users` (their sessions stop working at once). Every step above is recorded in `backoffice.staff_audit` (`staff.enrolment_issued`, `staff.enrolled`).

## 4. Elevations

1. The staff member opens **Access**, chooses **What for** (super-admin actions, publishing rules and law changes, or using a customer's support grant), writes a **Reason** (the ticket or incident) and **For how long** (up to 4 hours), and chooses **Ask for approval**.
2. A second staff member who could hold that scope opens **Access**, reads the request under **Waiting for your approval** and chooses **Approve** (their browser asks for their key first) or **Deny**.
3. The elevation starts at approval and ends at its expiry, or earlier with **End now**. A request nobody approved within an hour lapses.

| Scope                            | May ask                     | May approve                                 |
| -------------------------------- | --------------------------- | ------------------------------------------- |
| Super-admin actions              | super admins                | another super admin                         |
| Publishing rules and law changes | rules editors, super admins | another rules editor or super admin         |
| Using a customer's support grant | support, super admins       | another support staff member or super admin |

Destructive actions (ending a contract, changing a tenant's feature flags or API settings, moving a tenant to its own database, notifying controllers of a breach, approving an elevation, correcting an employee record through a support grant) also ask for the key again when the last proof is older than 5 minutes. Staff sessions end after 15 minutes without activity and after 4 hours in all.

## 5. Google Cloud staging: inviting the first staff member

The owner sets two GitHub repository variables, `GCP_STAFF_OWNER_EMAIL` and `GCP_STAFF_OWNER_NAME`, and re-runs **Deploy staging (Google Cloud)** (steps: [HUMAN_TODO §9](../HUMAN_TODO.md)). After the seed, the workflow runs the job `thapsus-stg-<cell>-staff-invite` once:

- it creates a `super_admin` staff account for that address, with no credential;
- it writes the one-time enrolment link to the Secret Manager secret `thapsus-stg-<cell>-staff-invite` (London only; only the jobs service account can write or read it; nothing is logged);
- it does nothing on later deploys while the back office has any staff account.

For a new link (the first one expired after 2 hours, or another device), run the workflow by hand with **staff_invite** ticked. Read the link with:

```sh
gcloud secrets versions access latest --secret=thapsus-stg-uk-staff-invite --project=<project-id>
```

The first super admin has no standing access either: until a second staff member exists to approve elevations, the owner can sign in and see the overview and the **Access** page only. To invite a second person (who then approves the owner's requests, and the owner theirs), set the two variables to that person's work email and name, run the workflow with **staff_invite** ticked, and give them the new link from the secret. With Cloud SQL access, section 2 works too.

## 6. Testing

- API: `apps/api/test/backoffice.int.test.ts` (passkey-only sign-in, enrolment, sessions, re-authentication, elevations), `apps/api/test/staff-invite.int.test.ts`.
- Browser: `apps/web/e2e/backoffice.spec.ts` uses Chrome's virtual WebAuthn authenticator (DevTools Protocol), so the real ceremony runs with no test-only path in the app. In e2e the back office is opened as `localhost`, because a passkey's relying party must be a host name, not an IP address.
