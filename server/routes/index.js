import { createRouter } from '../lib/router.js';
import { createMetaController } from '../controllers/metaController.js';
import { createEtfController } from '../controllers/etfController.js';
import { createAlertController } from '../controllers/alertController.js';
import { createRuleController } from '../controllers/ruleController.js';
import { createStreamController } from '../controllers/streamController.js';

export function buildRouter({ services }) {
  const router = createRouter();
  const meta = createMetaController({ services });
  const etf = createEtfController({ services });
  const alert = createAlertController({ services });
  const rule = createRuleController({ services });
  const stream = createStreamController({ services });

  router.get('/api/health', meta.health);
  router.get('/api/ready', meta.ready);
  router.get('/api/meta', meta.meta);
  router.get('/api/options', meta.options);

  router.get('/api/overview', etf.overview);
  router.get('/api/etfs', etf.list);
  router.get('/api/etfs/:code', etf.detail);
  router.get('/api/etfs/:code/intraday', etf.intraday);
  router.get('/api/etfs/:code/fast', etf.fast);
  router.get('/api/flows/ranking', etf.ranking);
  router.get('/api/flows/categories', etf.categories);
  router.post('/api/sync', etf.sync);

  router.get('/api/alerts', alert.list);
  router.get('/api/alerts/summary', alert.summary);

  router.get('/api/rules', rule.list);
  router.post('/api/rules', rule.create);
  router.patch('/api/rules/:id', rule.update);
  router.patch('/api/rules/:id/toggle', rule.toggle);
  router.delete('/api/rules/:id', rule.remove);

  router.get('/api/stream', stream.stream);

  return router;
}
