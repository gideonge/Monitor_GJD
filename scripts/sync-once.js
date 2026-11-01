import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../server/config/index.js';
import { createLogger } from '../server/lib/logger.js';
import { openDatabase, runMigrations } from '../server/db/index.js';
import { createEtfRepo } from '../server/repositories/etfRepo.js';
import { createFlowRepo } from '../server/repositories/flowRepo.js';
import { createAlertRepo } from '../server/repositories/alertRepo.js';
import { createRuleRepo } from '../server/repositories/ruleRepo.js';
import { createStateRepo } from '../server/repositories/stateRepo.js';
import { createEventBus } from '../server/services/events.js';
import { createMarketService } from '../server/services/marketService.js';

/**
 * 一次性同步脚本：不启动 HTTP 服务，直接把数据拉到本地库。
 * 适合放进 crontab / 计划任务，或用于排查数据问题。
 *
 *   npm run sync
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const logger = createLogger({ level: config.logLevel || 'info', bindings: { cli: 'sync-once' } });

const db = openDatabase(config.dbFile);
runMigrations(db, path.join(here, '..', 'server', 'db', 'migrations'), logger);

const repos = {
  etfRepo: createEtfRepo(db),
  flowRepo: createFlowRepo(db),
  alertRepo: createAlertRepo(db),
  ruleRepo: createRuleRepo(db),
  stateRepo: createStateRepo(db),
};
repos.ruleRepo.seedDefaults();

const events = createEventBus();
const marketService = createMarketService({ db, repos, events, logger });
marketService.hydrate();

const universe = await marketService.syncUniverse();
const daily = await marketService.backfillDaily();
const tick = await marketService.tick();
const status = marketService.getStatus();

process.stdout.write(
  `${JSON.stringify(
    {
      universe,
      daily,
      tick,
      alerts: repos.alertRepo.summarize({}).total,
      status,
    },
    null,
    2,
  )}\n`,
);

events.close();
db.close();
