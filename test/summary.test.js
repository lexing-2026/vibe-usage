import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../src/summary.js';

function bucket(source, model, cost, tokens) {
  return { source, model, project: '/repo/x', estimatedCost: cost, totalTokens: tokens };
}

const DATA = {
  buckets: [
    bucket('codex', 'gpt-5.5', 12.0, 3_000_000),
    bucket('alma', 'claude-opus-4.8', 0.5, 100_000),
    bucket('claude-code', 'claude-opus-4.8', 8.0, 9_000_000),
    // Unpriced model: lots of volume, no cost — must not outrank paid tools.
    bucket('mimocode', 'mimo-1', 0, 50_000_000),
  ],
  sessions: [],
};

function toolRows(md) {
  const body = md.split('## 按工具')[1].split('## 按模型')[0];
  return body
    .split('\n')
    .filter(l => l.startsWith('| ') && !l.startsWith('| 工具') && !l.startsWith('|---'))
    .map(l => l.split('|')[1].trim());
}

test('summary has a 按工具 table ordered by cost, biggest first', () => {
  const md = render(DATA, 7, 'https://vibecafe.ai');
  assert.match(md, /## 按工具/);
  assert.deepEqual(toolRows(md), ['Codex CLI', 'Claude Code', 'Alma', 'MiMoCode']);
});

test('按工具 sits above 按模型 and 按项目', () => {
  const md = render(DATA, 7, 'https://vibecafe.ai');
  assert.ok(md.indexOf('## 按工具') < md.indexOf('## 按模型'));
  assert.ok(md.indexOf('## 按模型') < md.indexOf('## 按项目'));
});

test('an unknown source falls back to its raw id instead of vanishing', () => {
  const md = render({ buckets: [bucket('brand-new-tool', 'm', 1, 10)], sessions: [] }, 7, 'x');
  assert.deepEqual(toolRows(md), ['brand-new-tool']);
});

test('empty data still short-circuits to the 暂无数据 message', () => {
  const md = render({ buckets: [], sessions: [] }, 7, 'https://vibecafe.ai');
  assert.match(md, /暂无数据/);
  assert.doesNotMatch(md, /## 按工具/);
});
