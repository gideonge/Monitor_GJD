import test from 'node:test';
import assert from 'node:assert/strict';
import { pickTrackedCodes, isTrackableCategory } from '../server/lib/trackedPool.js';

const rows = [
  { code: '511360', category: '债券货币' },
  { code: '510300', category: '宽基指数' },
  { code: '511090', category: '债券货币' },
  { code: '588000', category: '科技成长' },
  { code: '518880', category: '商品' },
];

test('排除债券货币：名额按成交额顺延，池子不会平白缩水', () => {
  const codes = pickTrackedCodes(rows, { size: 3, excludeCategories: ['债券货币'] });
  // 前两名债基被跳过，递补给宽基/科技/商品，仍是 3 只
  assert.deepEqual(codes, ['510300', '588000', '518880']);
});

test('不排除时按原顺序取满，用于回退到旧行为', () => {
  const codes = pickTrackedCodes(rows, { size: 3, excludeCategories: [] });
  assert.deepEqual(codes, ['511360', '510300', '511090']);
});

test('手工置顶优先于排除规则，且不重复、不超员', () => {
  const codes = pickTrackedCodes(rows, {
    pinned: ['511360', '510300'],
    size: 3,
    excludeCategories: ['债券货币'],
  });
  // 钉住的债基保留（显式操作优先），其余按成交额递补，总数仍是 3
  assert.deepEqual(codes, ['511360', '510300', '588000']);
});

test('置顶数量超过 size 时以置顶为准，不会截断用户显式选择', () => {
  const codes = pickTrackedCodes(rows, { pinned: ['518880', '588000'], size: 1, excludeCategories: [] });
  assert.deepEqual(codes, ['518880', '588000']);
});

test('脏数据与空输入不崩', () => {
  assert.deepEqual(pickTrackedCodes(null, { size: 5 }), []);
  assert.deepEqual(pickTrackedCodes([{ code: null }, { code: '510300', category: '宽基指数' }], { size: 5 }), ['510300']);
  assert.equal(isTrackableCategory('债券货币', ['债券货币']), false);
  assert.equal(isTrackableCategory('宽基指数', ['债券货币']), true);
});
