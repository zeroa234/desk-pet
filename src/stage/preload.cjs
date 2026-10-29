// 舞台（覆盖窗口）和主进程之间的通道，消息格式见 protocol.ts。
const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('pet', {
  onSpeech: cb => ipcRenderer.on('stage:speech', (_e, v) => cb(v)),
  onInit: cb => ipcRenderer.on('stage:init', (_e, v) => cb(v)),
  onFrame: cb => ipcRenderer.on('stage:frame', (_e, v) => cb(v)),
  onPassive: cb => ipcRenderer.on('stage:passive', (_e, v) => cb(v)),
  onSound: cb => ipcRenderer.on('stage:sound', (_e, v) => cb(v)),
  onSoundStop: cb => ipcRenderer.on('stage:sound-stop', () => cb()),
  ready: () => ipcRenderer.send('stage:ready'),
  hover: over => ipcRenderer.send('stage:hover', over),
  grab: id => ipcRenderer.send('stage:grab', id),
  poke: v => ipcRenderer.send('stage:poke', v),
  stat: v => ipcRenderer.send('stage:stat', v),
});
