import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from './config/index.js';
import { createLogger } from './lib/logger.js';
import { openDatabase, runMigrations } from './db/index.js';
import { createEtfRepo } from './repositories/etfRepo.js';
import { createFlowRepo } from './repositories/flowRepo.js';
import { createAlertRepo } from './repositories/alertRepo.js';
import { createRuleRepo } from './repositories/ruleRepo.js';
import { createStateRepo } from './repositories/stateRepo.js';
import { createIntradayRepo } from './repositories/intradayRepo.js';
import { createFastTickRepo } from './repositories/fastTickRepo.js';
import { createEventBus } from './services/events.js';
import { createMarketService } from './services/marketService.js';
import { createIntradayService } from './services/intradayService.js';
import { createVolumeSurgeService } from './services/volumeSurgeService.js';
import { createFastTickService } from './services/fastTickService.js';
import { createTickImpulseService } from './services/tickImpulseService.js';
import { createQueryService } from './services/queryService.js';
import { createCollector } from './jobs/collector.js';
import { createApp } from './app.js';

const logger = createLogger({ level: config.logLevel, bindings: { app: 'etf-flow-monitor' } });
const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const db = openDatabase(config.dbFile);
  runMigrations(db, path.join(here, 'db', 'migrations'), logger);

  const repos = {
    etfRepo: createEtfRepo(db),
    flowRepo: createFlowRepo(db),
    alertRepo: createAlertRepo(db),
    ruleRepo: createRuleRepo(db),
    stateRepo: createStateRepo(db),
    intradayRepo: createIntradayRepo(db),
    fastTickRepo: createFastTickRepo(db),
  };

  const seeded = repos.ruleRepo.seedDefaults();
  if (seeded > 0) logger.info('已写入默认阈值规则', { count: seeded });

  const events = createEventBus();
  const marketService = createMarketService({ db, repos, events, logger });
  const intradayService = createIntradayService({ db, repos, logger });
  const volumeSurgeService = createVolumeSurgeService({ repos, events, logger });
  const fastTickService = createFastTickService({ db, repos, logger });
  const tickImpulseService = createTickImpulseService({ repos, events, logger, fastTickService });
  const queryService = createQueryService({
    repos,
    marketService,
    intradayService,
    volumeSurgeService,
    fastTickService,
    tickImpulseService,
  });
  const collector = createCollector({
    marketService,
    intradayService,
    volumeSurgeService,
    fastTickService,
    tickImpulseService,
    logger,
  });

  const services = {
    db,
    repos,
    events,
    marketService,
    intradayService,
    volumeSurgeService,
    fastTickService,
    tickImpulseService,
    queryService,
    collector,
    config,
  };
  const handler = createApp({ services, logger, config });
  const server = http.createServer(handler);

  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  logger.info('服务已启动', {
    url: `http://${config.host}:${config.port}`,
    nodeEnv: config.nodeEnv,
    dbFile: config.dbFile,
    pollIntervalMs: config.pollIntervalMs,
    universeSize: config.universeSize,
  });

  collector.start();

  const shutdown = async (signal) => {
    logger.info('收到退出信号，开始优雅停机', { signal });
    collector.stop();
    await new Promise((resolve) => {
      server.close(() => resolve());
      setTimeout(resolve, 5000).unref?.();
    });
    events.close();
    try {
      db.close();
    } catch (error) {
      logger.warn('关闭数据库时出现异常', { err: error });
    }
    logger.info('停机完成');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    logger.error('未处理的 Promise 拒绝', { err: reason instanceof Error ? reason : { message: String(reason) } });
  });
  process.on('uncaughtException', (error) => {
    logger.error('未捕获异常，进程退出', { err: error });
    void shutdown('uncaughtException');
  });

  return { server, services };
}

main().catch((error) => {
  logger.error('启动失败', { err: error });
  process.exit(1);
});
