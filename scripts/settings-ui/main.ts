// 设置窗口验收（2026-10-29）：隐藏窗口 + 临时目录（scripts/settings-ui/host.ts），不动光标、不发系统键盘事件、不联网、不碰用户配置。
//   electron scripts/settings-ui/main.ts [--shots]        --shots：每页中英文 × 浅色深色截图到 output/settings-ui/
// 查：每页 axe-core 无障碍扫描（WCAG 2.1 A/AA）、控制台无报错（含 CSP）、开关 / 下拉 / 数字框就地校验 / 名单撤销 / 热键录制 /
// 提示词保存（Ctrl+S）/ 说话声音试听不保存 / 搜索跳转 / 切语言重建 / 改了要重启的提示条。结果写 output/settings-ui/report.json，有失败退出码 1。
import {app, nativeTheme} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {PROJECT, handleProtocol, setupPaths} from '../../src/main/env.ts';
import {createSettingsWindow} from '../../src/main/settings-window.ts';
import {PAGES} from '../../src/settings/protocol.ts';
import {fakeHost} from './host.ts';

setupPaths();
const qaRoot = fs.mkdtempSync(path.join(PROJECT, 'temp', 'settings-ui-'));
app.setPath('userData', path.join(qaRoot, 'user-data')); app.setPath('sessionData', path.join(qaRoot, 'session-data'));
app.commandLine.appendSwitch('disk-cache-dir', path.join(qaRoot, 'cache'));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const out = path.join(PROJECT, 'output', 'settings-ui');
fs.mkdirSync(out, {recursive: true});
const shots = process.argv.includes('--shots');
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  handleProtocol();
  const host = fakeHost(qaRoot);
  const sw = createSettingsWindow(PROJECT, host, {show: false});
  const win = sw.open('general');
  win.setBounds({x: -32000, y: -32000, width: 1080, height: 760});   // 放到屏幕外再显示（不抢焦点），截图要窗口画过
  win.setSkipTaskbar(true);
  const errors: string[] = [];
  win.webContents.on('console-message', e => { if (e.level === 'error' || e.level === 'warning') errors.push(String(e.message)); });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code, true) as Promise<T>;
  const waitFor = async (code: string, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await js(code)) return; await wait(50); } throw new Error(`timeout: ${code}`); };
  const go = async (page: string) => { await js(`location.hash='${page}'`); await waitFor(`!document.getElementById('page-${page}').hidden`); await wait(150); };
  const checks: Record<string, unknown> = {};
  const report: Record<string, unknown> = {qaRoot: path.relative(PROJECT, qaRoot), checks, axe: {}, errors};
  try {
    await new Promise<void>(r => win.webContents.once('did-finish-load', () => r()));
    win.showInactive();
    await waitFor(`!!document.getElementById('page-general')`);
    await js(fs.readFileSync(path.join(PROJECT, 'node_modules', 'axe-core', 'axe.min.js'), 'utf8'));
    // 截图（capturePage）只截页面、不含 Mica：用不透明的底色（和 Mica 的色调一样），截图和对比度检查才有意义
    await js(`document.documentElement.classList.remove('mica')`);

    // 开关：点一下就存（不需要“保存”），旁边出“已保存”
    await js(`document.querySelector('#paused input[role=switch]').click()`);
    await waitFor(`document.querySelector('#paused .status.ok') !== null`);
    assert.equal(host.settings.value.paused, true); checks.toggle = true;
    // 开机自启（宿主是假的，不写注册表）：开关走动作，读回来是开的
    await js(`document.querySelector('#autostart input[role=switch]').click()`);
    await waitFor(`document.querySelector('#autostart .status.ok') !== null`);
    assert.equal(host.view().state.autostart, true); checks.autostart = true;
    // 下拉
    await go('characters');
    await js(`(()=>{const s=document.getElementById('maxOnDesktop-select');s.value='2';s.dispatchEvent(new Event('change'))})()`);
    await waitFor(`document.querySelector('#maxOnDesktop .status.ok') !== null`);
    assert.equal(host.settings.value.maxOnDesktop, 2); checks.select = true;
    // 数字框就地校验：超范围标红、不提交
    await go('vision');
    const before = host.runtime.config.vision.intervalSec;
    await js(`(()=>{const i=document.querySelector('#vision-interval input');i.value='3';i.dispatchEvent(new Event('input'));i.dispatchEvent(new Event('change'))})()`);
    const invalid = await js<{aria: string; text: string}>(`(()=>{const i=document.querySelector('#vision-interval input');return {aria:i.getAttribute('aria-invalid'),text:document.getElementById(i.getAttribute('aria-describedby')).textContent}})()`);
    assert.equal(invalid.aria, 'true'); assert.ok(invalid.text.length > 0); assert.equal(host.runtime.config.vision.intervalSec, before);
    await js(`(()=>{const i=document.querySelector('#vision-interval input');i.value='45';i.dispatchEvent(new Event('input'));i.dispatchEvent(new Event('change'))})()`);
    await waitFor(`document.querySelector('#vision-interval .status.ok') !== null`);
    assert.equal(host.runtime.config.vision.intervalSec, 45); checks.numberInline = invalid;
    // 会话轮数互相约束：一次折叠 ≥ 上限时就地报错、不提交
    await go('ai');
    const first = host.view().llm!.characters[0].id;
    await js(`(()=>{const d=document.getElementById('ai-${first}');d.open=true;const i=d.querySelector('#ai-${first}-turns .turn-field:nth-child(2) input');i.value='80';i.dispatchEvent(new Event('input'));i.dispatchEvent(new Event('change'))})()`);
    const crossErr = await js<string>(`document.querySelector('#ai-${first}-turns .turn-field:nth-child(2) .field-error').textContent`);
    assert.ok(crossErr.length > 0); assert.equal(host.runtime.turnsOf(first).dropTurns, 30); checks.turnsCross = crossErr;
    // 提示词：改了出“未保存”，Ctrl+S 存进临时目录的 prompts.local.json
    await js(`(()=>{const a=document.getElementById('prompt-text');a.value='QA 测试人设';a.dispatchEvent(new Event('input'));})()`);
    assert.equal(await js(`document.querySelector('#prompt .chip.warning').hidden`), false);
    await js(`document.getElementById('prompt-text').dispatchEvent(new KeyboardEvent('keydown',{key:'s',ctrlKey:true,bubbles:true}))`);
    await waitFor(`document.querySelector('#prompt .chip.warning').hidden`);
    const prompts = JSON.parse(fs.readFileSync(path.join(qaRoot, 'config', 'prompts.local.json'), 'utf8'));
    assert.equal(prompts._shared.sfw, 'QA 测试人设'); checks.promptSave = true;
    // 程序名单：添加刚才在前台的，移除后提示气泡可撤销
    await go('quiet');
    await js(`document.getElementById('dndApps').open=true; [...document.querySelectorAll('#dndApps .btn')].find(b=>b.textContent.includes('Zoom.exe')).click()`);
    await waitFor(`document.querySelectorAll('#dndApps .app-item').length===1`);
    await js(`document.querySelector('#dndApps .app-item .btn').click()`);
    await waitFor(`document.querySelectorAll('#dndApps .app-item').length===0`);
    await js(`document.querySelector('#toast-host .btn').click()`);
    await waitFor(`document.querySelectorAll('#dndApps .app-item').length===1`);
    assert.deepEqual(host.settings.value.dndApps, ['Zoom.exe']); checks.appListUndo = true;
    // 热键录制：点按钮再按组合键（页面里发的键盘事件，不是系统输入）
    await go('general');
    await js(`(()=>{const b=document.querySelector('#bossKey .hotkey');b.focus();b.click();b.dispatchEvent(new KeyboardEvent('keydown',{key:'j',code:'KeyJ',ctrlKey:true,altKey:true,bubbles:true}))})()`);
    await waitFor(`document.querySelector('#bossKey .status.ok') !== null`);
    assert.equal(host.settings.value.bossKey, 'Control+Alt+J'); checks.hotkey = true;
    // 搜索：找“音量”，点结果跳到声音页
    await js(`(()=>{const s=document.getElementById('search');s.value='音量';s.dispatchEvent(new Event('input'))})()`);
    await waitFor(`document.querySelectorAll('#search-results .result').length>0`);
    await js(`document.querySelector('#search-results .result').click()`);
    await waitFor(`!document.getElementById('page-sound').hidden && document.activeElement?.closest('#volume') !== null`);
    checks.search = true;
    // 说话声音：试听不保存、保存后生效
    const voiceChar = host.view().llm!.characters[0].id;
    await js(`(()=>{const n=document.getElementById('voice-pitch-number');n.value='330';n.dispatchEvent(new Event('input'))})()`);
    assert.equal(await js(`document.querySelector('#voice .infobar').hidden`), false, 'unsaved bar');
    await js(`document.querySelector('#voice .voice-try .btn').click()`); await wait(200);
    assert.notEqual(host.runtime.voiceOf(voiceChar).pitch, 330, 'audition must not save');
    await js(`document.querySelector('#voice .infobar .btn.accent').click()`);
    await waitFor(`document.querySelector('#voice .infobar').hidden`);
    assert.equal(host.runtime.voiceOf(voiceChar).pitch, 330);
    assert.equal(host.runtime.store.summary().total, 0, 'no model calls'); checks.voice = true;
    // 改了要重启的设置：顶上出提示条
    await go('advanced');
    await js(`(()=>{document.getElementById('tuning').open=true;const i=document.querySelector('#tuning .tuning-row input');i.value='1300';i.dispatchEvent(new Event('input',{bubbles:true}));[...document.querySelectorAll('#tuning .btn.accent')][0].click()})()`);
    await waitFor(`document.querySelector('.content-inner > .live-bar .infobar.warning') !== null`);
    assert.equal(host.settings.value.tuning.gravity, 1300); checks.restartBar = true;
    // 切语言：整页重建成英文，停在原来那页
    await go('general');
    await js(`(()=>{const s=document.getElementById('language-select');s.value='en';s.dispatchEvent(new Event('change'))})()`);
    await waitFor(`document.documentElement.lang==='en' && document.getElementById('page-title').textContent==='General'`);
    checks.language = await js(`document.title`);

    // 无障碍扫描：每页（两种语言、两种主题都扫，颜色对比度跟主题走）
    const axe: Record<string, unknown> = {};
    for (const lang of ['en', 'zh-CN']) {
      host.set({language: lang}); sw.changed(); await waitFor(`document.documentElement.lang==='${lang}'`);
      for (const theme of ['light', 'dark'] as const) {
        nativeTheme.themeSource = theme; await wait(200);
        for (const page of PAGES) {
          await go(page);
          await wait(page === 'appearance' || page === 'characters' ? 700 : 250);
          const r = await js<{id: string; impact: string; nodes: string[]}[]>(`axe.run(document, {runOnly: {type: 'tag', values: ['wcag2a','wcag2aa','wcag21a','wcag21aa']}, resultTypes: ['violations']})
            .then(r => r.violations.map(v => ({id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 4).map(n => n.target.join(' '))})))`);
          if (r.length) axe[`${lang}/${theme}/${page}`] = r;
          if (shots) fs.writeFileSync(path.join(out, `${lang}-${theme}-${page}.png`), (await win.webContents.capturePage()).toPNG());
        }
      }
    }
    report.axe = axe;
    if (shots) {   // 窄窗口：导航只剩图标、控件换行
      nativeTheme.themeSource = 'light';
      win.setBounds({x: -32000, y: -32000, width: 700, height: 760}); await go('ai'); await wait(300);
      fs.writeFileSync(path.join(out, 'zh-CN-light-narrow-ai.png'), (await win.webContents.capturePage()).toPNG());
    }
    const failed = Object.keys(axe).length > 0 || errors.length > 0;
    report.result = failed ? 'failed' : 'ok';
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 1));
    host.close(); app.exit(failed ? 1 : 0);
  } catch (e) {
    report.result = 'failed'; report.error = e instanceof Error ? e.stack : String(e);
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 1));
    host.close(); app.exit(1);
  }
});
setTimeout(() => { console.error('timeout'); app.exit(2); }, 240_000).unref();
