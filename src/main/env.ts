// 主进程环境：把 Electron 默认写 %APPDATA% 的目录全部改到项目内（design.md §15，R13.5），注册 pet:// 协议。
//   pet://app/<相对项目根的路径>   只读，.ts 文件现场去类型（Node 自带 stripTypeScriptTypes）后当 JS 给出；只放出 src/、packs/、i18next 的 ESM 目录
// 必须在 app.whenReady 之前调 setupPaths()，之后调 handleProtocol()。
// 自写；协议、路径都是 Electron 自带 API。
import {app, net, protocol} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {stripTypeScriptTypes} from 'node:module';

export const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function setupPaths(): void {
  const run = path.join(PROJECT, 'data', 'electron');
  app.setPath('userData', run);
  app.setPath('sessionData', path.join(run, 'session'));
  app.setPath('logs', path.join(PROJECT, 'logs', 'electron'));
  app.setPath('crashDumps', path.join(PROJECT, 'logs', 'electron', 'crash'));
  app.setPath('temp', path.join(PROJECT, 'temp', 'electron'));
  app.commandLine.appendSwitch('disk-cache-dir', path.join(run, 'cache'));
  protocol.registerSchemesAsPrivileged([{scheme: 'pet', privileges: {standard: true, secure: true, supportFetchAPI: true, corsEnabled: true}}]);
}

const TYPES: Record<string, string> = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.css': 'text/css'};
const tsCache = new Map<string, {mtime: number; code: string}>();

export function handleProtocol(extraSpriteDirs: readonly string[] = []): void {
  // 设置窗口经 import map 加载 i18next 的 ESM 单文件（src/settings/index.html）：node_modules 只放出这一个目录
  const allowed = [path.join(PROJECT,'src'),path.join(PROJECT,'packs'),path.join(PROJECT,'node_modules','i18next','dist','esm'),...extraSpriteDirs.map(d=>path.resolve(PROJECT,d))]
    .filter(d=>d.startsWith(PROJECT+path.sep)).map(d=>d+path.sep);
  protocol.handle('pet', async req => {
    const url = new URL(req.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    // Renderers need runtime source and exported pack assets, never local credentials or saves.
    const file = path.resolve(PROJECT, rel);
    if (!allowed.some(base=>file.startsWith(base))) return new Response('not found', {status: 404});
    if (url.host !== 'app' || !file.startsWith(PROJECT + path.sep) || !fs.existsSync(file)) return new Response('not found', {status: 404});
    if (file.endsWith('.ts')) {
      const mtime = fs.statSync(file).mtimeMs;
      let hit = tsCache.get(file);
      if (!hit || hit.mtime !== mtime) tsCache.set(file, hit = {mtime, code: stripTypeScriptTypes(fs.readFileSync(file, 'utf8'))});
      return new Response(hit.code, {headers: {'content-type': 'text/javascript'}});
    }
    const res = await net.fetch(pathToFileURL(file).toString());
    return new Response(res.body, {headers: {'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream'}});
  });
}
