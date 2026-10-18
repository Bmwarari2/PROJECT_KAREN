# Admin guide: scheduled data export

Thapsus-HR can send data from the report builder's datasets (people, leave requests, sickness absence, timesheets) to storage your organisation owns, every day, week or month. Exports go to:

- an **Amazon S3 bucket in your workspace's home region**, written through an IAM role in your AWS account that Thapsus-HR assumes; or
- an **SFTP server**, identified by its pinned host key.

Who can do this: people with the `exports.destinations` permission add destinations, and people with `exports.schedule` schedule exports (both are part of the HR admin, owner and payroll admin roles). Go to **Reports → Data exports**.

## What is sent

- You choose the dataset and the fields. Rows and fields follow the access rights of the person who set up the export, evaluated again at every delivery, so a delivery never contains more than that person can see at that time.
- Encrypted (vault) fields, such as sickness reasons and diversity data, are **never** exported.
- Files are CSV (UTF-8, header row with field keys) or JSON Lines, one file per dataset per period: `<prefix>/<dataset>/<dataset>-<period>.<csv|jsonl>`. "As of" datasets (people) are a snapshot on the delivery date; period datasets cover the previous day, week or month.
- Each delivery is recorded in the delivery log with status, number of files, rows, bytes, duration and an error code. The log never contains personal data.
- Once a file reaches your bucket or server, it is in your systems: you are the controller and your retention and access rules apply (see docs/SUBPROCESSORS.md).

## Amazon S3

### 1. The bucket must be in your home region

| Workspace home region | Bucket region |
| --- | --- |
| UK | `eu-west-2` (London) |
| EU | `eu-central-1` (Frankfurt) |
| US | `us-east-2` (Ohio) |

Thapsus-HR refuses any other region when you add the destination, and checks the bucket's real region (S3 `HeadBucket`) before every delivery. A bucket in another region fails with `bucketRegionMismatch` and nothing is written.

### 2. Create the IAM role

1. Add the destination in **Reports → Data exports → Add a destination** with your bucket name, the region above, an optional folder prefix and the ARN of the role you are about to create. After saving, the destination shows an **External ID** (`thr-…`). Copy it.
2. In your AWS account, create an IAM role whose **name starts with `thapsus-hr-export-`** (for example `thapsus-hr-export-hr-data`). Thapsus-HR can only assume roles with this prefix; any other name is refused.
3. Trust policy (replace the account ID with the Thapsus-HR account for your region, which support gives you, and the External ID with yours):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::<THAPSUS_HR_ACCOUNT_ID>:root" },
      "Action": "sts:AssumeRole",
      "Condition": {
        "StringEquals": { "sts:ExternalId": "thr-0123456789abcdef0123456789abcdef" }
      }
    }
  ]
}
```

The External ID is unique to your destination, so no other Thapsus-HR customer can make us write into your bucket. Within the Thapsus-HR account, only the API and worker of your home region may call `sts:AssumeRole`, and only on `arn:aws:iam::*:role/thapsus-hr-export-*`.

4. Permissions policy (least privilege; replace the bucket and prefix):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::<bucket>" },
    { "Effect": "Allow", "Action": ["s3:PutObject", "s3:DeleteObject"], "Resource": "arn:aws:s3:::<bucket>/<prefix>*" }
  ]
}
```

`s3:ListBucket` lets us confirm the bucket's region (`HeadBucket`). `s3:DeleteObject` is only used by **Test connection**, which writes a small marker file and removes it again; leave it out if you prefer and delete the marker yourself. If the bucket uses SSE-KMS with your own key, also allow `kms:GenerateDataKey` on that key.

5. Press **Test connection**. Common results: `assumeRoleFailed` (role name, trust policy or External ID), `accessDenied` (permissions policy), `bucketRegionMismatch` (bucket region).

Sessions last 15 minutes and are created per delivery; Thapsus-HR stores no long-lived AWS keys for your account.

## SFTP

1. Get the server's host key fingerprint in OpenSSH SHA256 form, for example `ssh-keyscan -t ed25519 sftp.example.com | ssh-keygen -lf -` (it starts with `SHA256:`). Check it with your server administrator through a trusted channel.
2. Add the destination with host, port, user name, optional folder, the fingerprint and either a private key (OpenSSH format, optional passphrase) or a password. Keys and passwords are encrypted with your region's KMS key and are never shown again.
3. Every connection checks the host key; a different key fails with `hostKeyMismatch` and nothing is sent. Servers on private or local network addresses are refused (`hostNotAllowed`).

## Schedules and retries

Deliveries run at the time and IANA time zone you choose (daily, weekly on a weekday, or monthly on day 1–28). Each period is delivered once; **Send now** delivers the current period on demand. Network failures (`timeout`, `connect`, `transfer`) are retried with back-off; configuration errors are not retried until you fix them. Pausing an export stops future deliveries; deleting a destination that exports still use is refused.
