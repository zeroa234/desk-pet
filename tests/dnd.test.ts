// 勿扰（N8.1，2026-10-21）的判断：src/main/dnd.ts 的 dndReason。
import test from 'node:test';
import assert from 'node:assert/strict';

import {dndLabel, dndReason, type DndInput} from '../src/main/dnd.ts';

const BASE: DndInput = {manual: false, followSystem: true, fullscreen: true, apps: [], quietHours: 0, notification: 'accepts-notifications',
  foregroundFull: false, foregroundExe: 'notepad.exe', ours: false};

test('dndReason：什么都没有 → null', () => {
  assert.equal(dndReason(BASE), null);
  assert.equal(dndReason({...BASE, quietHours: null}), null);   // 读不到 Windows 勿扰当没开
});

test('dndReason：手动开着优先', () => {
  assert.equal(dndReason({...BASE, manual: true, quietHours: 2, foregroundFull: true}), 'manual');
});

test('dndReason：Windows 勿扰（只要优先通知 1、只要闹钟 2）和安静时间；关掉“跟着 Windows”就不算', () => {
  assert.equal(dndReason({...BASE, quietHours: 1}), 'system');
  assert.equal(dndReason({...BASE, quietHours: 2}), 'system');
  assert.equal(dndReason({...BASE, notification: 'quiet-time'}), 'system');
  assert.equal(dndReason({...BASE, followSystem: false, quietHours: 2}), null);
});

test('dndReason：全屏 / 演示（通知状态或前台盖满屏幕）；前台是桌宠自己、开关关掉都不算', () => {
  for (const n of ['busy', 'd3d-fullscreen', 'presentation'] as const) assert.equal(dndReason({...BASE, notification: n}), 'fullscreen');
  assert.equal(dndReason({...BASE, foregroundFull: true}), 'fullscreen');
  assert.equal(dndReason({...BASE, foregroundFull: true, ours: true}), null);
  assert.equal(dndReason({...BASE, foregroundFull: true, fullscreen: false}), null);
  assert.equal(dndReason({...BASE, notification: 'app'}), null);   // Windows Store 应用在跑，不算全屏
});

test('dndReason：名单里的程序在前台（不分大小写），原因带原来的文件名', () => {
  assert.equal(dndReason({...BASE, apps: ['Zoom.exe'], foregroundExe: 'zoom.EXE'}), 'app:zoom.EXE');
  assert.equal(dndReason({...BASE, apps: ['Zoom.exe'], foregroundExe: 'notepad.exe'}), null);
  assert.equal(dndReason({...BASE, apps: ['Zoom.exe'], foregroundExe: null}), null);
});

test('dndLabel：界面里的说法（词条键 + 参数）', () => {
  assert.deepEqual(dndLabel('manual'), {key: 'dnd.reason.manual'});
  assert.deepEqual(dndLabel('system'), {key: 'dnd.reason.system'});
  assert.deepEqual(dndLabel('fullscreen'), {key: 'dnd.reason.fullscreen'});
  assert.deepEqual(dndLabel('app:Zoom.exe'), {key: 'dnd.reason.app', params: {exe: 'Zoom.exe'}});
});
