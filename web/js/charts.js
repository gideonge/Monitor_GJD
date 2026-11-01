import { escapeHtml, fmtAmount, fmtClock } from './format.js';

const COLOR = {
  in: '#c2452f',
  out: '#22795c',
  grid: '#eef1f5',
  axis: '#9aa6b5',
  ink: '#5b6b7f',
  accent: '#3d6591',
};

let gradientSeq = 0;

const axisAmount = (value) => {
  const abs = Math.abs(value);
  if (abs >= 1e8) return `${(value / 1e8).toFixed(abs >= 1e9 ? 0 : 1)}亿`;
  if (abs >= 1e4) return `${(value / 1e4).toFixed(0)}万`;
  return `${value.toFixed(0)}`;
};

/** 日级净流入柱状图：零轴居中，红涨绿跌 */
export function drawBarChart(container, { data = [], height = 210, valueFormat = fmtAmount } = {}) {
  if (!container) return;
  const width = Math.max(320, container.clientWidth || 640);
  if (data.length === 0) {
    container.innerHTML = '<div class="empty">暂无日级资金流数据</div>';
    return;
  }

  const padL = 64;
  const padR = 12;
  const padT = 12;
  const padB = 26;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const maxAbs = Math.max(...data.map((item) => Math.abs(item.value)), 1);
  const zeroY = padT + plotH / 2;
  const yOf = (value) => zeroY - (value / maxAbs) * (plotH / 2);
  const step = plotW / data.length;
  const barW = Math.max(1.2, Math.min(16, step * 0.66));

  const bars = data
    .map((item, index) => {
      const x = padL + index * step + (step - barW) / 2;
      const top = Math.min(yOf(item.value), zeroY);
      const barHeight = Math.max(1, Math.abs(zeroY - yOf(item.value)));
      const color = item.value >= 0 ? COLOR.in : COLOR.out;
      return `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${barW.toFixed(1)}" height="${barHeight.toFixed(
        1,
      )}" fill="${color}"><title>${escapeHtml(item.label)}  ${escapeHtml(valueFormat(item.value))}</title></rect>`;
    })
    .join('');

  const ticks = [maxAbs, maxAbs / 2, 0, -maxAbs / 2, -maxAbs];
  const grid = ticks
    .map((value) => {
      const y = yOf(value);
      const isZero = value === 0;
      return `<line x1="${padL}" x2="${width - padR}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${
        isZero ? '#cfd6df' : COLOR.grid
      }" stroke-width="1"${isZero ? '' : ' stroke-dasharray="3 3"'} />
      <text x="${padL - 8}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="${COLOR.axis}" font-family="ui-monospace, monospace">${axisAmount(
        value,
      )}</text>`;
    })
    .join('');

  const labelIndexes = new Set();
  const labelCount = Math.min(6, data.length);
  for (let i = 0; i < labelCount; i += 1) {
    labelIndexes.add(Math.round((i * (data.length - 1)) / Math.max(1, labelCount - 1)));
  }
  const xLabels = [...labelIndexes]
    .map((index) => {
      const item = data[index];
      const x = padL + index * step + step / 2;
      return `<text x="${x.toFixed(1)}" y="${height - 8}" text-anchor="middle" font-size="10" fill="${COLOR.axis}" font-family="ui-monospace, monospace">${escapeHtml(
        String(item.label).slice(5),
      )}</text>`;
    })
    .join('');

  container.innerHTML = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="日级主力净流入柱状图">
    ${grid}${bars}${xLabels}
  </svg>`;
}

/** 分时累计净流入面积图：带十字光标与浮层提示 */
export function drawAreaChart(container, { points = [], height = 200, emptyText = '暂无分时数据' } = {}) {
  if (!container) return;
  const width = Math.max(320, container.clientWidth || 640);
  container.innerHTML = '';

  if (points.length < 2) {
    container.innerHTML = `<div class="empty">${escapeHtml(
      `${emptyText}：该标的当前仅有 ${points.length} 个采样点，盘中轮询累积 2 个点后自动生成分时曲线`,
    )}</div>`;
    return;
  }

  const padL = 64;
  const padR = 12;
  const padT = 12;
  const padB = 24;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const values = points.map((point) => point.value);
  let yMax = Math.max(...values, 0);
  let yMin = Math.min(...values, 0);
  if (yMax === yMin) {
    yMax += 1;
    yMin -= 1;
  }
  const span = yMax - yMin;
  yMax += span * 0.08;
  yMin -= span * 0.08;

  const t0 = points[0].ts;
  const t1 = points[points.length - 1].ts;
  const timeSpan = Math.max(t1 - t0, 1);

  const xOf = (ts) => padL + ((ts - t0) / timeSpan) * plotW;
  const yOf = (value) => padT + (1 - (value - yMin) / (yMax - yMin)) * plotH;

  const linePath = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${xOf(point.ts).toFixed(1)},${yOf(point.value).toFixed(1)}`).join(' ');
  const zeroY = yOf(0);
  const areaPath = `${linePath} L${xOf(t1).toFixed(1)},${zeroY.toFixed(1)} L${xOf(t0).toFixed(1)},${zeroY.toFixed(1)} Z`;

  const gradientId = `grad-${(gradientSeq += 1)}`;
  const gridTicks = [yMax, (yMax + yMin) / 2, yMin];
  const grid = gridTicks
    .map(
      (value) =>
        `<line x1="${padL}" x2="${width - padR}" y1="${yOf(value).toFixed(1)}" y2="${yOf(value).toFixed(
          1,
        )}" stroke="${COLOR.grid}" stroke-dasharray="3 3" />
         <text x="${padL - 8}" y="${(yOf(value) + 3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="${
           COLOR.axis
         }" font-family="ui-monospace, monospace">${axisAmount(value)}</text>`,
    )
    .join('');

  const xTicks = [t0, t0 + timeSpan / 2, t1]
    .map(
      (ts) =>
        `<text x="${xOf(ts).toFixed(1)}" y="${height - 6}" text-anchor="middle" font-size="10" fill="${
          COLOR.axis
        }" font-family="ui-monospace, monospace">${fmtClock(ts).slice(0, 5)}</text>`,
    )
    .join('');

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', '盘中累计净流入分时曲线');
  svg.innerHTML = `
    <defs>
      <linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${COLOR.accent}" stop-opacity="0.22" />
        <stop offset="100%" stop-color="${COLOR.accent}" stop-opacity="0.01" />
      </linearGradient>
    </defs>
    ${grid}
    <line x1="${padL}" x2="${width - padR}" y1="${zeroY.toFixed(1)}" y2="${zeroY.toFixed(1)}" stroke="#cfd6df" />
    <path d="${areaPath}" fill="url(#${gradientId})" />
    <path d="${linePath}" fill="none" stroke="${COLOR.accent}" stroke-width="1.6" stroke-linejoin="round" />
    ${xTicks}
    <g class="crosshair" style="display:none">
      <line y1="${padT}" y2="${padT + plotH}" stroke="${COLOR.ink}" stroke-width="1" stroke-dasharray="2 2" />
      <circle r="3" fill="${COLOR.accent}" stroke="#fff" stroke-width="1.5" />
    </g>
    <rect class="hit-area" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent" style="cursor:crosshair" />
  `;
  container.appendChild(svg);

  const tooltip = document.createElement('div');
  tooltip.className = 'tooltip';
  container.appendChild(tooltip);

  const crosshair = svg.querySelector('.crosshair');
  const crossLine = crosshair.querySelector('line');
  const crossDot = crosshair.querySelector('circle');
  const hitArea = svg.querySelector('.hit-area');

  const handleMove = (event) => {
    const rect = svg.getBoundingClientRect();
    const scale = rect.width / width;
    const x = (event.clientX - rect.left) / scale;
    const ratio = Math.min(1, Math.max(0, (x - padL) / plotW));
    const ts = t0 + ratio * timeSpan;

    let nearest = points[0];
    let bestDelta = Infinity;
    for (const point of points) {
      const delta = Math.abs(point.ts - ts);
      if (delta < bestDelta) {
        bestDelta = delta;
        nearest = point;
      }
    }

    const px = xOf(nearest.ts);
    const py = yOf(nearest.value);
    crosshair.style.display = '';
    crossLine.setAttribute('x1', String(px));
    crossLine.setAttribute('x2', String(px));
    crossDot.setAttribute('cx', String(px));
    crossDot.setAttribute('cy', String(py));

    tooltip.classList.add('is-on');
    tooltip.innerHTML = `${fmtClock(nearest.ts)}<br/>累计净流入 ${fmtAmount(nearest.value)}`;
    const left = Math.min(Math.max(px * scale + 12, 4), rect.width - 130);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${Math.max(py * scale - 46, 0)}px`;
  };

  hitArea.addEventListener('mousemove', handleMove);
  hitArea.addEventListener('mouseleave', () => {
    crosshair.style.display = 'none';
    tooltip.classList.remove('is-on');
  });
}

const axisVolume = (hands) => {
  const abs = Math.abs(hands);
  if (abs >= 1e8) return `${(hands / 1e8).toFixed(1)}亿手`;
  if (abs >= 1e4) return `${(hands / 1e4).toFixed(0)}万手`;
  return `${Math.round(hands)}手`;
};

const minuteValue = (minute) => Number(String(minute).slice(0, 2)) * 60 + Number(String(minute).slice(3));

const INTRADAY_MARKS = [
  { minute: '09:30', label: '09:30' },
  { minute: '10:30', label: '10:30' },
  { minute: '11:30', label: '11:30/13:00' },
  { minute: '14:00', label: '14:00' },
  { minute: '15:00', label: '15:00' },
];

/**
 * 分时走势图：上区为当日价格线（含均价线与昨收基准，相对昨收红涨绿跌），
 * 下区为逐分钟成交量柱，共享时间轴；带十字光标浮层。
 * 用于收盘后回看最后交易日的分时价格与量能。
 *
 * events 为量能突变事件（volumeSurge 检测结果），用竖向虚线 + 圆点标注在该分钟上。
 * 标注颜色统一用中性蓝：量能突变本身不代表涨跌方向（回测里强信号也多是顺势突破），
 * 用红绿会让用户误读成「放量必涨/必跌」。
 */
export function drawIntradayChart(
  container,
  { bars = [], preClose = null, height = 296, emptyText = '暂无分时数据', events = [] } = {},
) {
  if (!container) return;
  container.innerHTML = '';
  const width = Math.max(360, container.clientWidth || 720);

  if (bars.length < 2) {
    container.innerHTML = `<div class="empty">${escapeHtml(emptyText)}</div>`;
    return;
  }

  const padL = 56;
  const padR = 56;
  const padT = 12;
  const padB = 20;
  const plotW = width - padL - padR;
  const bodyH = height - padT - padB;
  const volH = bodyH * 0.28;
  const gap = 10;
  const priceH = bodyH - volH - gap;
  const priceTop = padT;
  const volTop = padT + priceH + gap;

  const base = preClose && preClose > 0 ? preClose : bars[0].price;
  const values = bars.map((bar) => bar.price).concat(bars.map((bar) => bar.avgPrice).filter((v) => typeof v === 'number'));
  let priceHigh = Math.max(...values);
  let priceLow = Math.min(...values);
  if (priceHigh === priceLow) {
    priceHigh = base * 1.004;
    priceLow = base * 0.996;
  }
  // 纵轴以当日价格区间为主，昨收最多把区间向单侧扩展 35%：
  // 这样全天单边下跌/上涨时价格线不会被压成一条窄带，同时基准线仍尽量可见。
  const priceRange = priceHigh - priceLow;
  let hi = Math.max(priceHigh, Math.min(base, priceHigh + priceRange * 0.35));
  let lo = Math.min(priceLow, Math.max(base, priceLow - priceRange * 0.35));
  const paddingValue = (hi - lo) * 0.06;
  hi += paddingValue;
  lo -= paddingValue;

  const last = bars[bars.length - 1];
  const rising = last.price >= base;
  const mainColor = rising ? COLOR.in : COLOR.out;

  const xOf = (index) => padL + (bars.length <= 1 ? plotW / 2 : (index / (bars.length - 1)) * plotW);
  const yOf = (value) => priceTop + (1 - (value - lo) / (hi - lo)) * priceH;
  const maxVol = Math.max(1, ...bars.map((bar) => bar.volume));

  const pricePath = bars
    .map((bar, index) => `${index === 0 ? 'M' : 'L'}${xOf(index).toFixed(1)},${yOf(bar.price).toFixed(1)}`)
    .join(' ');
  const avgPath = bars
    .map((bar, index) =>
      typeof bar.avgPrice === 'number'
        ? `${index === 0 ? 'M' : 'L'}${xOf(index).toFixed(1)},${yOf(bar.avgPrice).toFixed(1)}`
        : '',
    )
    .filter(Boolean)
    .join(' ');
  const baseY = yOf(base);
  // 昨收线在可视区间内：填充到基准线，面积即当日偏离幅度；
  // 全天单边行情导致基准线在区间外：改为填充到价格区底部（普通面积），避免大面积误读。
  const baseInRange = baseY >= priceTop - 0.5 && baseY <= priceTop + priceH + 0.5;
  const fillY = baseInRange ? baseY : priceTop + priceH;
  const areaPath = `${pricePath} L${xOf(bars.length - 1).toFixed(1)},${fillY.toFixed(1)} L${xOf(0).toFixed(1)},${fillY.toFixed(1)} Z`;

  const gridTicks = [hi, (hi + lo) / 2, lo];
  const grid = gridTicks
    .map((value) => {
      const y = yOf(value);
      const pct = base > 0 ? ((value - base) / base) * 100 : 0;
      const pctColor = pct > 0.001 ? COLOR.in : pct < -0.001 ? COLOR.out : COLOR.axis;
      return `<line x1="${padL}" x2="${width - padR}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${
        COLOR.grid
      }" stroke-dasharray="3 3" />
      <text x="${padL - 8}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="${
        COLOR.axis
      }" font-family="ui-monospace, monospace">${value.toFixed(3)}</text>
      <text x="${width - padR + 8}" y="${(y + 3.5).toFixed(1)}" font-size="10" fill="${pctColor}" font-family="ui-monospace, monospace">${
        pct >= 0 ? '+' : ''
      }${pct.toFixed(2)}%</text>`;
    })
    .join('');

  const barW = Math.max(1, Math.min(6, (plotW / bars.length) * 0.85));
  const volBars = bars
    .map((bar, index) => {
      const prev = index === 0 ? base : bars[index - 1].price;
      const color = bar.price >= prev ? COLOR.in : COLOR.out;
      // 分钟量可能相差 3 个数量级（尾盘巨量 vs 常态），给矮柱一个可见下限，且始终贴底
      const h = Math.max(1.3, (bar.volume / maxVol) * volH);
      const y = volTop + volH - h;
      return `<rect x="${(xOf(index) - barW / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(
        1,
      )}" height="${h.toFixed(1)}" fill="${color}" opacity="0.9"><title>${escapeHtml(bar.minute)} ${escapeHtml(
        axisVolume(bar.volume),
      )}</title></rect>`;
    })
    .join('');

  const minuteIndex = (minute) => {
    const exact = bars.findIndex((bar) => bar.minute === minute);
    if (exact >= 0) return exact;
    const target = minuteValue(minute);
    let best = 0;
    let bestDiff = Infinity;
    bars.forEach((bar, index) => {
      const diff = Math.abs(minuteValue(bar.minute) - target);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = index;
      }
    });
    return best;
  };
  const xLabels = INTRADAY_MARKS.map((mark) => {
    const index = minuteIndex(mark.minute);
    return `<text x="${xOf(index).toFixed(1)}" y="${height - 6}" text-anchor="middle" font-size="10" fill="${
      COLOR.axis
    }" font-family="ui-monospace, monospace">${escapeHtml(mark.label)}</text>`;
  }).join('');

  const tickYs = gridTicks.map((value) => yOf(value));
  const showBaseLabel = baseInRange && tickYs.every((y) => Math.abs(y - baseY) > 9);
  const baseLine = baseInRange
    ? `<line x1="${padL}" x2="${width - padR}" y1="${baseY.toFixed(1)}" y2="${baseY.toFixed(
        1,
      )}" stroke="${COLOR.axis}" stroke-width="1" stroke-dasharray="4 3" opacity="0.75" />${
        showBaseLabel
          ? `<text x="${width - padR + 8}" y="${(baseY + 3.5).toFixed(1)}" font-size="9" fill="${
              COLOR.axis
            }" font-family="ui-monospace, monospace">0.00%</text>`
          : ''
      }`
    : '';

  /**
   * 量能突变标注：竖向参考线贯穿价格区与量能区，价格线上打点。
   * 只有落在当前分钟序列里的事件才画（事件可能来自另一交易日）。
   */
  const eventByMinute = new Map();
  for (const item of events ?? []) {
    if (item && item.minute) eventByMinute.set(item.minute, item);
  }
  const surgeMarks = eventByMinute.size
    ? bars
        .map((bar, index) => {
          const hit = eventByMinute.get(bar.minute);
          if (!hit) return '';
          const px = xOf(index);
          const py = yOf(bar.price);
          const radius = hit.level >= 3 ? 3.6 : 2.6;
          const dash = hit.direction === 'drain' ? '2 3' : '4 3';
          return `<g>
        <line x1="${px.toFixed(1)}" x2="${px.toFixed(1)}" y1="${priceTop}" y2="${(volTop + volH).toFixed(
          1,
        )}" stroke="${COLOR.accent}" stroke-width="1" stroke-dasharray="${dash}" opacity="0.3" />
        <circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${radius}" fill="${
          COLOR.accent
        }" stroke="#fff" stroke-width="1.3" opacity="0.95"><title>${escapeHtml(
          `${bar.minute} 量能 ${Number(hit.ratio).toFixed(1)}× 近 20 分钟基线（${hit.levelLabel ?? ''}）`,
        )}</title></circle>
      </g>`;
        })
        .join('')
    : '';

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', '分时价格与成交量图');
  svg.innerHTML = `
    <defs>
      <linearGradient id="intraday-fill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${mainColor}" stop-opacity="${baseInRange ? '0.22' : '0.12'}" />
        <stop offset="100%" stop-color="${mainColor}" stop-opacity="0.02" />
      </linearGradient>
    </defs>
    ${grid}
    <path d="${areaPath}" fill="url(#intraday-fill)" />
    ${baseLine}
    ${avgPath ? `<path d="${avgPath}" fill="none" stroke="${COLOR.axis}" stroke-width="1" stroke-dasharray="1 2" opacity="0.9" />` : ''}
    <path d="${pricePath}" fill="none" stroke="${mainColor}" stroke-width="1.5" stroke-linejoin="round" />
    ${surgeMarks}
    <line x1="${padL}" x2="${width - padR}" y1="${volTop}" y2="${volTop}" stroke="#dfe4ea" stroke-width="1" />
    ${volBars}
    <text x="${padL - 8}" y="${(volTop + 10).toFixed(1)}" text-anchor="end" font-size="9" fill="${COLOR.axis}" font-family="ui-monospace, monospace">${axisVolume(
      maxVol,
    )}</text>
    ${xLabels}
    <g class="intraday-cross" style="display:none">
      <line y1="${priceTop}" y2="${volTop + volH}" stroke="${COLOR.ink}" stroke-width="1" stroke-dasharray="2 2" />
      <circle r="3" fill="${mainColor}" stroke="#fff" stroke-width="1.5" />
    </g>
    <rect class="hit-area" x="${padL}" y="${priceTop}" width="${plotW}" height="${bodyH}" fill="transparent" style="cursor:crosshair" />
  `;
  container.appendChild(svg);

  const tooltip = document.createElement('div');
  tooltip.className = 'tooltip';
  container.appendChild(tooltip);

  const cross = svg.querySelector('.intraday-cross');
  const crossLine = cross.querySelector('line');
  const crossDot = cross.querySelector('circle');
  // 必须按 class 取透明命中层：图内还有 200+ 个成交量柱（同为 rect）
  const hitArea = svg.querySelector('.hit-area');

  hitArea.addEventListener('mousemove', (event) => {
    const rect = svg.getBoundingClientRect();
    const scale = rect.width / width;
    const x = (event.clientX - rect.left) / scale;
    const ratio = Math.min(1, Math.max(0, (x - padL) / plotW));
    const index = Math.round(ratio * (bars.length - 1));
    const bar = bars[index];
    if (!bar) return;

    const px = xOf(index);
    const py = yOf(bar.price);
    cross.style.display = '';
    crossLine.setAttribute('x1', String(px));
    crossLine.setAttribute('x2', String(px));
    crossDot.setAttribute('cx', String(px));
    crossDot.setAttribute('cy', String(py));

    const pct = base > 0 ? ((bar.price - base) / base) * 100 : 0;
    const cls = pct > 0 ? '#ff3b2f' : pct < 0 ? '#00a06a' : '#ffffff';
    const hit = eventByMinute.get(bar.minute);
    const surgeText = hit
      ? `<br/><b style="color:#9fc0e6">量能 ${Number(hit.ratio).toFixed(1)}× 基线 · ${
          hit.direction === 'drain' ? '骤减' : '突变'
        }${hit.levelLabel ? `（${hit.levelLabel}）` : ''}</b>`
      : '';
    tooltip.classList.add('is-on');
    tooltip.innerHTML = `${escapeHtml(bar.minute)}　<b style="color:${cls}">${bar.price.toFixed(3)} ${
      pct >= 0 ? '+' : ''
    }${pct.toFixed(2)}%</b><br/>量 ${escapeHtml(axisVolume(bar.volume))}　额 ${escapeHtml(
      fmtAmount(bar.amount, { sign: false }),
    )}${typeof bar.avgPrice === 'number' ? `<br/>均价 ${bar.avgPrice.toFixed(3)}` : ''}${surgeText}`;
    const left = Math.min(Math.max(px * scale + 12, 4), rect.width - 168);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${Math.max(py * scale - 20, 0)}px`;
  });

  hitArea.addEventListener('mouseleave', () => {
    cross.style.display = 'none';
    tooltip.classList.remove('is-on');
  });
}

/**
 * 秒级盘口图：上区为逐秒价格线，下区为「每秒主动净买入额」柱（零轴居中）。
 *
 * 为什么下区不用成交量柱：秒级成交量里混着做市报价的来回对冲，
 * 而外盘-内盘的增量才是「谁在主动吃单」的直接证据——国家队扫单就表现为连续的正向柱。
 * x 轴按真实时间比例铺开（不是按索引），停牌或长时间无成交留下的空档会如实保留。
 */
export function drawFastChart(
  container,
  { points = [], impulses = [], height = 210, emptyText = '等待盘中秒级数据' } = {},
) {
  if (!container) return;
  container.innerHTML = '';
  const width = Math.max(320, container.clientWidth || 640);

  if (points.length < 2) {
    container.innerHTML = `<div class="empty">${escapeHtml(emptyText)}</div>`;
    return;
  }

  const padL = 56;
  const padR = 56;
  const padT = 10;
  const padB = 18;
  const plotW = width - padL - padR;
  const bodyH = height - padT - padB;
  // 价格区与净额区之间留 12px：两侧的纵轴文字（3.942 / 719万）才不会叠在一起
  const gap = 12;
  const priceH = (bodyH - gap) * 0.655;
  const volH = bodyH - gap - priceH;
  const priceTop = padT;
  const volTop = padT + priceH + gap;

  const prices = points.map((point) => Number(point.price)).filter((value) => Number.isFinite(value));
  let hi = Math.max(...prices);
  let lo = Math.min(...prices);
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) {
    container.innerHTML = `<div class="empty">${escapeHtml(emptyText)}</div>`;
    return;
  }
  if (hi === lo) {
    hi += hi * 0.0008 || 0.001;
    lo -= lo * 0.0008 || 0.001;
  }
  const pricePad = (hi - lo) * 0.12;
  hi += pricePad;
  lo -= pricePad;

  /**
   * 净额满幅取 p98 而不是最大值：单秒偶尔会出现一笔远超常态的扫单，
   * 用最大值定标会把其余 99% 的秒压成一条平线。超出满幅的柱按满幅封顶，
   * 真实数值在浮层里显示，形态与量级都不丢。
   */
  const absNets = points
    .map((point) => Math.abs(Number(point.net) || 0))
    .filter((value) => value > 0)
    .sort((a, b) => a - b);
  const p98 = absNets.length > 0 ? absNets[Math.floor(0.98 * (absNets.length - 1))] : 1;
  const maxNet = Math.max(1, p98) * 1.08;

  const t0 = points[0].ts;
  const t1 = points[points.length - 1].ts;
  const span = Math.max(1, t1 - t0);
  const xOf = (ts) => padL + ((ts - t0) / span) * plotW;
  const yOf = (value) => priceTop + (1 - (value - lo) / (hi - lo)) * priceH;
  const clampNet = (value) => Math.max(-maxNet, Math.min(maxNet, value));
  const netY = (value) => volTop + volH / 2 - (clampNet(value) / maxNet) * (volH / 2);

  const rising = Number(points[points.length - 1].price) >= Number(points[0].price);
  const mainColor = rising ? COLOR.in : COLOR.out;

  const pricePath = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${xOf(point.ts).toFixed(1)},${yOf(Number(point.price)).toFixed(1)}`)
    .join(' ');
  const areaPath = `${pricePath} L${xOf(t1).toFixed(1)},${(priceTop + priceH).toFixed(1)} L${xOf(t0).toFixed(
    1,
  )},${(priceTop + priceH).toFixed(1)} Z`;

  const gridTicks = [hi, (hi + lo) / 2, lo];
  const grid = gridTicks
    .map((value) => {
      const y = yOf(value);
      return `<line x1="${padL}" x2="${width - padR}" y1="${y.toFixed(1)}" y2="${y.toFixed(
        1,
      )}" stroke="${COLOR.grid}" stroke-dasharray="3 3" />
      <text x="${padL - 8}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="${
        COLOR.axis
      }" font-family="ui-monospace, monospace">${value.toFixed(3)}</text>`;
    })
    .join('');

  const barW = Math.max(0.8, Math.min(3.2, (plotW / points.length) * 0.9));
  const netBars = points
    .map((point) => {
      const value = Number(point.net);
      if (!Number.isFinite(value) || value === 0) return '';
      const zeroY = netY(0);
      const y = netY(value);
      const h = Math.max(0.8, Math.abs(zeroY - y));
      const top = Math.min(zeroY, y);
      return `<rect x="${(xOf(point.ts) - barW / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${barW.toFixed(
        1,
      )}" height="${h.toFixed(1)}" fill="${value > 0 ? COLOR.in : COLOR.out}" opacity="0.85" />`;
    })
    .join('');

  const zeroLine = `<line x1="${padL}" x2="${width - padR}" y1="${netY(0).toFixed(1)}" y2="${netY(0).toFixed(
    1,
  )}" stroke="#cfd6df" stroke-width="1" />`;

  // 时间刻度：窗口 ≤5 分钟按分钟，>5 分钟按 2 分钟，>15 分钟按 5 分钟
  const stepSec = span <= 300_000 ? 60 : span <= 900_000 ? 120 : 300;
  const xLabels = [];
  const startTick = Math.ceil(t0 / (stepSec * 1000)) * stepSec * 1000;
  for (let ts = startTick; ts <= t1; ts += stepSec * 1000) {
    const x = xOf(ts);
    const date = new Date(ts);
    const label = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    xLabels.push(
      `<text x="${x.toFixed(1)}" y="${height - 5}" text-anchor="middle" font-size="10" fill="${
        COLOR.axis
      }" font-family="ui-monospace, monospace">${escapeHtml(label)}</text>`,
    );
  }

  // 攻势区间标注：与告警同源（同一套检测参数与波次合并规则），所以图上的阴影
  // 和告警栏里的每一条能一一对上。主动买用红、主动卖用绿，与 A 股涨跌色一致。
  const impulseMarks = (Array.isArray(impulses) ? impulses : [])
    .filter((item) => Number(item.endTs) >= t0 && Number(item.startTs) <= t1)
    .map((item) => {
      const isBuy = item.direction !== 'drain';
      const color = isBuy ? COLOR.in : COLOR.out;
      const x1 = xOf(Math.max(Number(item.startTs), t0));
      const x2 = Math.max(x1 + 1.5, xOf(Math.min(Number(item.endTs), t1)));
      const label = `${isBuy ? '主动买' : '主动卖'} ${axisAmount(Math.abs(item.sumNet))}`;
      const labelX = Math.min(Math.max(x1 + 2, padL + 2), width - padR - 46);
      return `<g>
        <rect x="${x1.toFixed(1)}" y="${priceTop}" width="${(x2 - x1).toFixed(1)}" height="${priceH.toFixed(
          1,
        )}" fill="${color}" opacity="0.08" />
        <line x1="${x2.toFixed(1)}" x2="${x2.toFixed(1)}" y1="${priceTop}" y2="${(volTop + volH).toFixed(
          1,
        )}" stroke="${color}" stroke-width="1" stroke-dasharray="2 3" opacity="0.55" />
        <text x="${labelX.toFixed(1)}" y="${(priceTop + 10).toFixed(1)}" font-size="9" fill="${color}" font-family="ui-monospace, monospace">${escapeHtml(
          label,
        )}</text>
      </g>`;
    })
    .join('');

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', '秒级价格与主动买卖净额图');
  svg.innerHTML = `
    <defs>
      <linearGradient id="fast-fill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${mainColor}" stop-opacity="0.18" />
        <stop offset="100%" stop-color="${mainColor}" stop-opacity="0.02" />
      </linearGradient>
    </defs>
    ${grid}
    ${impulseMarks}
    <path d="${areaPath}" fill="url(#fast-fill)" />
    <path d="${pricePath}" fill="none" stroke="${mainColor}" stroke-width="1.3" stroke-linejoin="round" />
    <line x1="${padL}" x2="${width - padR}" y1="${volTop}" y2="${volTop}" stroke="#dfe4ea" stroke-width="1" />
    ${zeroLine}
    ${netBars}
    <text x="${padL - 8}" y="${(volTop + 10).toFixed(1)}" text-anchor="end" font-size="9" fill="${
      COLOR.axis
    }" font-family="ui-monospace, monospace">${escapeHtml(axisAmount(maxNet))}</text>
    <text x="${padL - 8}" y="${(netY(0) + 3.5).toFixed(1)}" text-anchor="end" font-size="9" fill="${
      COLOR.axis
    }" font-family="ui-monospace, monospace">0</text>
    ${xLabels.join('')}
    <g class="fast-cross" style="display:none">
      <line y1="${priceTop}" y2="${volTop + volH}" stroke="${COLOR.ink}" stroke-width="1" stroke-dasharray="2 2" />
      <circle r="3" fill="${mainColor}" stroke="#fff" stroke-width="1.5" />
    </g>
    <rect class="hit-area" x="${padL}" y="${priceTop}" width="${plotW}" height="${bodyH}" fill="transparent" style="cursor:crosshair" />
  `;
  container.appendChild(svg);

  const tooltip = document.createElement('div');
  tooltip.className = 'tooltip';
  container.appendChild(tooltip);

  const cross = svg.querySelector('.fast-cross');
  const crossLine = cross.querySelector('line');
  const crossDot = cross.querySelector('circle');
  const hitArea = svg.querySelector('.hit-area');

  hitArea.addEventListener('mousemove', (event) => {
    const rect = svg.getBoundingClientRect();
    const scale = rect.width / width;
    const x = (event.clientX - rect.left) / scale;
    const targetTs = t0 + ((x - padL) / plotW) * span;

    // 点可能很稀（停牌/无成交），按时间就近取，不做线性插值以免造出不存在的成交
    let best = points[0];
    let bestDiff = Infinity;
    for (const point of points) {
      const diff = Math.abs(point.ts - targetTs);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = point;
      }
    }
    if (!best) return;

    const px = xOf(best.ts);
    const py = yOf(Number(best.price));
    cross.style.display = '';
    crossLine.setAttribute('x1', String(px));
    crossLine.setAttribute('x2', String(px));
    crossDot.setAttribute('cx', String(px));
    crossDot.setAttribute('cy', String(py));

    const netText =
      best.net === null || best.net === undefined
        ? '—'
        : `${best.net > 0 ? '+' : ''}${fmtAmount(best.net, { sign: false })}`;
    const netColor = (Number(best.net) || 0) > 0 ? '#ff6b5e' : (Number(best.net) || 0) < 0 ? '#4fbf94' : '#ffffff';
    tooltip.classList.add('is-on');
    tooltip.innerHTML = `${escapeHtml(best.minute ?? '')}　<b>${Number(best.price).toFixed(3)}</b>${
      best.pctChg === null || best.pctChg === undefined
        ? ''
        : ` ${best.pctChg >= 0 ? '+' : ''}${Number(best.pctChg).toFixed(2)}%`
    }<br/>主动净买 <b style="color:${netColor}">${escapeHtml(netText)}</b>　本秒额 ${escapeHtml(
      fmtAmount(best.amt ?? 0, { sign: false }),
    )}${Number.isFinite(best.imba) ? `<br/>买一/卖一 不平衡 ${(best.imba * 100).toFixed(0)}%` : ''}`;
    const left = Math.min(Math.max(px * scale + 12, 4), rect.width - 176);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${Math.max(py * scale - 20, 0)}px`;
  });

  hitArea.addEventListener('mouseleave', () => {
    cross.style.display = 'none';
    tooltip.classList.remove('is-on');
  });
}
