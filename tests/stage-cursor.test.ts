// 舞台页面的光标样式（src/stage/cursor.ts，2026-10-29 用户：打开设置窗口，鼠标在界面里移动，光标在正常指针和抓手之间来回变）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {stageCursor} from '../src/stage/cursor.ts';

test('不拥有鼠标的舞台窗口一律 default：穿透着的窗口没有光标要显示，不论主进程给的是 grab 还是 grabbing', () => {
  assert.equal(stageCursor('grab', false), 'default');
  assert.equal(stageCursor('grabbing', false), 'default');
  assert.equal(stageCursor('default', false), 'default');
});

test('拥有鼠标（光标压在角色上、或正拎着角色）时用主进程给的样式', () => {
  assert.equal(stageCursor('grab', true), 'grab');
  assert.equal(stageCursor('grabbing', true), 'grabbing');
  assert.equal(stageCursor('default', true), 'default');
});
