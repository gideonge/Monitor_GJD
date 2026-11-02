import { config } from '../config/index.js';
import { marketPhase, tradeDateOf } from '../lib/time.js';

/**
 * 采集调度器：初始化 + 三条独立循环。
 * 使用 setTimeout 递归而非 setInterval，天然避免任务重叠；
 * 任一任务失败只记录错误并等待下一轮，不做静默重试风暴。
 */
export function createCollector({
  marketService,
  intradayService,
  volumeSurgeService,
  fastTickService,
  tickImpulseService,
  intraMinuteSurgeService,
  logger,
}) {
  const log = logger.child({ module: 'collector' });
  const timers = new Set();
  let stopped = false;
  let started = false;

  function later(fn, delayMs) {
    if (stopped) return;
    const timer = setTimeout(async () => {
      timers.delete(timer);
      try {
        await fn();
      } catch (error) {
        log.error('调度任务异常', { err: error });
      }
    }, delayMs);
    timer.unref?.();
    timers.add(timer);
  }

  /**
   * minDelayMs 默认 1 秒，防止异常任务空转打上游；
   * 秒级通道需要更细的补偿粒度，传入 300ms 让 1 秒周期不会漂成 1.3 秒。
   */
  function loop(name, intervalMs, task, startDelayMs = intervalMs, minDelayMs = 1000) {
    const run = async () => {
      if (stopped) return;
      const startedAt = Date.now();
      try {
        await task();
      } finally {
        const elapsed = Date.now() - startedAt;
        later(run, Math.max(minDelayMs, intervalMs - elapsed));
      }
    };
    later(run, startDelayMs);
  }

  async function tickTask() {
    const phase = marketPhase();
    const closed = phase === 'closed' || phase === 'weekend';
    const sinceLast = Date.now() - (marketService.state.lastTickAt ?? 0);
    // 非交易时段降频：5 分钟同步一次收盘快照，避免空转打上游
    if (closed && sinceLast < 5 * 60 * 1000) return;

    const result = await marketService.tick();
    if (!result.ok) return;

    const latestQuoteTs = Math.max(0, ...[...marketService.getQuotes().values()].map((row) => row.quoteTs ?? 0));
    const quoteTradeDate = latestQuoteTs > 0 ? tradeDateOf(latestQuoteTs) : null;
    if (quoteTradeDate && quoteTradeDate !== marketService.state.lastTradeDate) {
      log.info('检测到新交易日，触发日级回填', { quoteTradeDate, previous: marketService.state.lastTradeDate });
      await marketService.backfillDaily({ force: true });
    }
  }

  async function universeTask() {
    await marketService.syncUniverse();
  }

  /**
   * 收盘后回填监控池的最后交易日分时（价格 + 成交量）。
   * 只在已收盘时执行，且 3 小时内不重复；串行拉取，属于后台低优先级任务。
   */
  async function intradayTask() {
    if (!intradayService) return;
    const phase = marketPhase();
    if (phase !== 'closed' && phase !== 'weekend') return;
    const sinceLast = Date.now() - (intradayService.getStatus().lastBackfillAt ?? 0);
    if (sinceLast < 3 * 3600 * 1000) return;
    await intradayService.backfillTracked();
    // 收盘后补录一次量能突变：只保留强信号，作为当日异动的正式记录
    await volumeSurgeService?.scan();
    // 秒级攻势同样补录一次：收盘后回看「今天国家队扫了几波」，只看强信号
    await tickImpulseService?.scan({ force: true });
  }

  /**
   * 量能突变预警：先刷新监控池的当日分钟数据，再扫描。
   * 刷新是按轮转限量进行的（每轮 liveRefreshLimit 只），因此不会阻塞其它任务；
   * 非交易时段直接跳过，收盘后的补录交给 intradayTask。
   */
  async function surgeTask() {
    if (!volumeSurgeService) return;
    const phase = marketPhase();
    if (phase !== 'trading' && phase !== 'closing') return;
    if (intradayService) await intradayService.refreshLive({ limit: config.volumeSurge.liveRefreshLimit });
    await volumeSurgeService.scan();
  }

  /**
   * 秒级通道：只对核心池（国家队常买宽基）1 秒采样一次。
   * poll 内部自行判断交易时段与熔断，非交易时段几乎零成本；
   * 尾部缓冲在每次跳过后立即冲刷，保证收盘最后一秒的数据也能落库。
   */
  async function fastTask() {
    if (!fastTickService) return;
    const result = await fastTickService.poll();
    if (!result.ok || result.skipped) fastTickService.flushNow();
  }

  /**
   * 秒级攻势预警：每 5 秒扫一次核心池的秒级流。
   *
   * 比采集（1 秒）粗一档是刻意的：15 秒桶在 5 秒粒度下已能被检出新桶，
   * 而每秒重算一遍 15 只 × 900 秒的点序列纯属浪费 CPU。
   */
  async function impulseTask() {
    if (!tickImpulseService) return;
    const phase = marketPhase();
    if (phase !== 'trading' && phase !== 'closing') return;
    await tickImpulseService.scan();
  }

  /**
   * 分钟内实时爆量：每 2 秒扫一次核心池，判定「正在形成的那一分钟」。
   *
   * 这是整条链路上唯一能在爆量发生时（而不是收盘后）给结论的通道：
   * 秒级采集 1 秒、上游快照约 3 秒、本环 2 秒，端到端延迟在 5 秒以内，
   * 判定本身从第 9 秒开始。不需要等分钟 K 线落库，因此也不受 refreshLive 轮转影响。
   */
  async function preburstTask() {
    if (!intraMinuteSurgeService) return;
    const phase = marketPhase();
    if (phase !== 'trading' && phase !== 'closing') return;
    await intraMinuteSurgeService.scan();
  }

  async function maintenanceTask() {
    marketService.pruneSnapshots();
    intradayService?.prune();
    fastTickService?.prune();
  }

  return {
    async start() {
      if (started) return;
      started = true;
      // 首轮初始化在后台执行，不阻塞 HTTP 服务可用性
      (async () => {
        try {
          log.info('开始初始化数据', { universeSize: config.universeSize, historyDays: config.historyDays });
          marketService.hydrate();
          await marketService.syncUniverse();
          await marketService.backfillDaily();
          marketService.refreshDailyAlerts();
          await marketService.tick();
          log.info('初始化完成', marketService.getStatus());
          // 收盘状态下补一次分时，保证「点开即看最后交易日分时」
          await intradayTask();
        } catch (error) {
          log.error('初始化失败，将依赖后续轮询恢复', { err: error });
        }
      })();

      loop('tick', config.pollIntervalMs, tickTask, 0);
      loop('universe', config.universeRefreshMs, universeTask);
      loop('intraday', 30 * 60 * 1000, intradayTask);
      // 留 15 秒给初始化（清单/日线/分时），避免首轮扫描撞上初始化请求
      loop('surge', config.volumeSurge.scanIntervalMs, surgeTask, 15000);
      loop('fast', config.fastTick.intervalMs, fastTask, 5000, 300);
      // 秒级攻势扫描：等采集环先跑几轮把内存缓冲攒起来（8 秒 ≈ 8 个点）
      loop('impulse', config.tickImpulse.scanIntervalMs, impulseTask, 8000, 500);
      // 分钟内实时爆量：同样等采集环攒点，基线不足时由检测器自己拒绝判定
      loop('preburst', config.intraMinute.scanIntervalMs, preburstTask, 9000, 500);
      loop('maintenance', 60 * 60 * 1000, maintenanceTask);
    },

    stop() {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}
