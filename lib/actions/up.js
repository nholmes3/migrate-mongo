const { isAfter, parse } = require("date-fns");
const _ = require("lodash");
const pEachSeries = require("p-each-series");
const { promisify } = require("util");
const fnArgs = require('fn-args');

const status = require("./status");
const config = require("../env/config");
const migrationsDir = require("../env/migrationsDir");
const hasCallback = require('../utils/has-callback');

module.exports = async (db, client) => {
  const statusItems = await status(db);
  const pendingItems = _.filter(statusItems, { appliedAt: "PENDING" });
  const migrated = [];

  const migrateItem = async item => {
    const dateOptionValue = _.get(global.options, "before");
    const beforeDate = parse(dateOptionValue, 'yyyyMMdd', new Date())

    const prefix = item.fileName.split("-")[0];
    const date = parse(prefix, 'yyyyMMddHHmmss', new Date());
    if (date.toString() === 'Invalid Date') {
      console.log(`Migration file: ${item.fileName} does not have a valid date string prefix and will not be run`)
      return
    }

    if (isAfter(date, beforeDate)) {
      console.log(`Migration file: ${item.fileName} is after the specified date and will not be run`)
      return
    }
    try {
      const migration = await migrationsDir.loadMigration(item.fileName);
      const up = hasCallback(migration.up) ? promisify(migration.up) : migration.up;

      if (hasCallback(migration.up) && fnArgs(migration.up).length < 3) {
        // support old callback-based migrations prior to migrate-mongo 7.x.x
        await up(db);
      } else {
        await up(db, client);
      }

    } catch (err) {
      const error = new Error(
        `Could not migrate up ${item.fileName}: ${err.message}`
      );
      error.stack = err.stack;
      error.migrated = migrated;
      throw error;
    }

    const { changelogCollectionName, useFileHash } = await config.read();
    const changelogCollection = db.collection(changelogCollectionName);

    const { fileName, fileHash } = item;
    const appliedAt = new Date();

    try {
      await changelogCollection.insertOne(useFileHash === true ? { fileName, fileHash, appliedAt } : { fileName, appliedAt });
    } catch (err) {
      throw new Error(`Could not update changelog: ${err.message}`);
    }
    migrated.push(item.fileName);
  };

  await pEachSeries(pendingItems, migrateItem);
  return migrated;
};
