// 设置窗口的预加载（src/main/settings-window.ts）：只放出三个请求和两个通知，约定见 src/settings/protocol.ts。
const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('petSettings', {
  view: () => ipcRenderer.invoke('settings:view'),
  set: patch => ipcRenderer.invoke('settings:set', patch),
  act: action => ipcRenderer.invoke('settings:act', action),
  onChanged: cb => ipcRenderer.on('settings:changed', () => cb()),
  onPage: cb => ipcRenderer.on('settings:page', (_e, page) => cb(page)),
});
