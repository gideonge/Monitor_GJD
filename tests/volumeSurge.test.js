import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectVolumeSurge,
  sessionOf,
  gradeIntensity,
  median,
  SESSIONS,
  EXCLUDED_MINUTES,
} from '../server/services/volumeSurge.js';

/** 生成上午 09:31-11:30、下午 13:01-14:56 的完整分钟列表 */
function allMinutes() {
  const minutes = [];
  for (const session of SESSIONS) {
    const [sh, sm] = session.start.split(':').map(Number);
    const [eh, em] = session.end.split(':').map(Number);
    for (let t = sh * 60 + sm; t <= eh * 60 + em; t += 1) {
      minutes.push(`${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
    }
  }
  return minutes;
}

/** 构造价格平稳、量能平稳的序列；volumeAt 可对指定分钟覆写成交量 */
function buildBars({ baseVolume = 1000, volumeAt = {}, priceAt = {}, basePrice = 4 } = {}) {
  const bars = [];
  let price = basePrice;
  for (const minute of allMinutes()) {
    price = priceAt[minute] ?? price;
    bars.push({
      minute,
      close: price,
      volume: volumeAt[minute] ?? baseVolume,
      amount: (volumeAt[minute] ?? baseVolume) * 100 * price,
    });
  }
  return bars;
}

test('时段与剔除分钟：集合竞价与午休过渡点不参与判定', () => {
  assert.equal(sessionOf('09:30'), null, '开盘集合竞价应剔除');
  assert.equal(sessionOf('13:00'), null, '午休结束过渡点应剔除');
  assert.equal(sessionOf('14:58'), null, '收盘集合竞价应剔除');
  assert.equal(sessionOf('15:00'), null, '收盘撮合应剔除');
  assert.equal(sessionOf('09:31'), 'am');
  assert.equal(sessionOf('11:30'), 'am');
  assert.equal(sessionOf('13:01'), 'pm');
  assert.equal(sessionOf('14:56'), 'pm');
  assert.ok(EXCLUDED_MINUTES.has('09:30'));
});

test('平稳序列不产生任何告警', () => {
  const { events, stats } = detectVolumeSurge(buildBars());
  assert.equal(events.length, 0, `平稳序列不应告警，实际 ${events.length} 个`);
  assert.ok(stats.tradableBars > 200);
});

test('U 型量能结构（开盘/尾盘放量）不会成片误报', () => {
  // 开盘量是盘中的 8 倍、尾盘是盘中的 5 倍：真实市场的常态结构。
  // 用全天均值倍数法会把这 15 个开盘分钟全部报出来（全天均值约 1902，×3 门槛 5706）；
  // 局部基线只会在「台阶转折那一根」有反应，量级完全不同。
  const volumeAt = {};
  for (const minute of allMinutes()) {
    if (minute >= '09:31' && minute <= '09:45') volumeAt[minute] = 8000;
    else if (minute >= '14:30' && minute <= '14:56') volumeAt[minute] = 5000;
    else volumeAt[minute] = 1000;
  }
  const bars = buildBars({ volumeAt });
  const { events } = detectVolumeSurge(bars);

  assert.ok(events.length <= 6, `局部基线应把 U 型结构基本吸收，实际告警 ${events.length} 个`);

  // 残余告警应只出现在台阶转折点，而不是整个放量区间
  const plateauMinutes = events.filter(
    (event) =>
      (event.minute >= '09:33' && event.minute <= '09:45') ||
      (event.minute >= '14:32' && event.minute <= '14:56'),
  );
  assert.equal(plateauMinutes.length, 0, '放量平台内部不应持续告警');
});

test('平稳序列中注入单分钟放量能被检出，且倍数与等级正确', () => {
  const bars = buildBars({ volumeAt: { '10:15': 20000 } });
  const { events } = detectVolumeSurge(bars);
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.minute, '10:15');
  assert.equal(event.direction, 'surge');
  assert.ok(event.ratio > 15, `倍数应接近 20，实际 ${event.ratio}`);
  assert.ok(event.z > 4);
  assert.equal(event.level, 3, '极端放量应为 3 级');
});

test('基线窗口不跨越午休：下午开盘的量能水平不拿上午做参照', () => {
  // 上午量 2000、下午量 1000。若基线窗口错误地跨午休取数，
  // 下午第一分钟会被判为「骤减」；正确实现应在下午重新积累基线。
  const volumeAt = {};
  for (const minute of allMinutes()) {
    volumeAt[minute] = minute <= '11:30' ? 2000 : 1000;
  }
  const { events } = detectVolumeSurge(buildBars({ volumeAt }));
  assert.equal(events.length, 0, `跨午休串基线会造成误报，实际 ${events.length} 个`);
});

test('量能骤减（枯竭）可被检出', () => {
  const volumeAt = { '10:30': 60 };
  const { events } = detectVolumeSurge(buildBars({ volumeAt }));
  assert.equal(events.length, 1);
  assert.equal(events[0].direction, 'drain');
  assert.equal(events[0].minute, '10:30');
  assert.ok(events[0].ratio < 0.1);
});

test('关闭骤减检测后不再报枯竭', () => {
  const { events } = detectVolumeSurge(buildBars({ volumeAt: { '10:30': 60 } }), { detectDrain: false });
  assert.equal(events.length, 0);
});

test('冷却期内不重复告警', () => {
  // 10:15 与 10:18 相隔 3 分钟，小于默认冷却 5 分钟，应只保留首个
  const bars = buildBars({ volumeAt: { '10:15': 20000, '10:18': 20000 } });
  const { events } = detectVolumeSurge(bars);
  assert.equal(events.length, 1);
  assert.equal(events[0].minute, '10:15');

  const { events: spaced } = detectVolumeSurge(bars, { cooldownBars: 0 });
  assert.equal(spaced.length, 2);
});

test('绝对成交额门槛过滤地量噪声', () => {
  // 全天量 10 手（约 4000 元/分钟）的地量标的，放到 200 手（约 8 万元）是 20 倍，
  // 相对门槛拦不住（门槛随标的一起缩小），必须靠与标的无关的绝对金额下限。
  const volumeAt = {};
  for (const minute of allMinutes()) volumeAt[minute] = 10;
  volumeAt['10:00'] = 200;

  const bars = buildBars({ volumeAt });
  assert.equal(detectVolumeSurge(bars).events.length, 1, '不设绝对门槛时会被误报');
  assert.equal(detectVolumeSurge(bars, { minAmount: 300000 }).events.length, 0, '设绝对金额门槛后应过滤');
});

test('区间突破确认：只保留价格同向突破前高的放量', () => {
  // 构造：9:31-10:10 价格在 4.00 横盘，10:11 放量但价格不动，10:12 放量且突破
  const volumeAt = { '10:11': 20000, '10:12': 20000 };
  const priceAt = {};
  for (const minute of allMinutes()) priceAt[minute] = 4;
  priceAt['10:12'] = 4.02;

  const plain = detectVolumeSurge(buildBars({ volumeAt, priceAt }), { cooldownBars: 0 });
  assert.equal(plain.events.length, 2, '不加确认时应报 2 个');

  const strict = detectVolumeSurge(buildBars({ volumeAt, priceAt }), {
    requireRangeBreak: true,
    cooldownBars: 0,
  });
  assert.equal(strict.events.length, 1, '区间突破确认后只保留突破那一根');
  assert.equal(strict.events[0].minute, '10:12');
  assert.ok(strict.events[0].tickRet > 0);
});

test('价格位移门槛过滤无方向的被动放量', () => {
  const bars = buildBars({ volumeAt: { '10:20': 20000 } });
  assert.equal(detectVolumeSurge(bars).events.length, 1);
  assert.equal(detectVolumeSurge(bars, { minTickPct: 0.05 }).events.length, 0);
});

test('开盘头几分钟基线不足时不做判定', () => {
  const { events, stats } = detectVolumeSurge(buildBars({ volumeAt: { '09:32': 50000 } }), { minBaseline: 8 });
  assert.equal(events.length, 0, '基线不足应跳过');
  assert.ok(stats.skipped > 0);
});

test('强度分级单调：倍数越大等级越高', () => {
  const weak = gradeIntensity({ ratio: 3.2, z: 4.2 });
  const mid = gradeIntensity({ ratio: 6, z: 8 });
  const strong = gradeIntensity({ ratio: 20, z: 30 });
  assert.ok(weak.level <= mid.level);
  assert.ok(mid.level <= strong.level);
  assert.equal(strong.level, 3);
});

test('中位数实现正确（奇偶长度）', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), 0);
});

test('空输入与异常量值不抛错', () => {
  assert.equal(detectVolumeSurge([]).events.length, 0);
  assert.equal(detectVolumeSurge(null).events.length, 0);
  const bars = buildBars();
  bars[50].volume = null;
  bars[60].volume = -1;
  assert.doesNotThrow(() => detectVolumeSurge(bars));
});
