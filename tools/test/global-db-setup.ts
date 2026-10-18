import { resetDatabase, TEST_DBS } from '../../packages/db/src/testing';

/** Fresh, fully migrated test databases for every integration/isolation/residency/contract run. */
export default async function setup() {
  await resetDatabase(TEST_DBS.shared);
  await resetDatabase(TEST_DBS.dedicated);
}
