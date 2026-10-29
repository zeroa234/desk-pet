// Electron implements capture / resizing / encoding. Only screen scope is implemented.
import {app, BrowserWindow, desktopCapturer, screen} from 'electron';
import {createHash} from 'node:crypto';
import type {Platform} from '../platform/index.ts';
import {blockedApp, type CaptureScope, type CaptureTarget, type CapturedFrame, type VisionConfig} from '../vision/index.ts';
const shell=new Set(['Progman','WorkerW','Shell_TrayWnd','Shell_SecondaryTrayWnd','#32768','NotifyIconOverflowWindow','XamlExplorerHostIslandWindow']);
export class ScreenCapture {
  private restore:(w:BrowserWindow,was:boolean)=>boolean;
  private platform:Platform;private config:()=>VisionConfig;private active:()=>boolean;
  private previous:ReturnType<Platform['foregroundApp']>=null;
  constructor(platform:Platform,config:()=>VisionConfig,active=()=>true,restore=(w:BrowserWindow,was:boolean)=>was) {this.platform=platform;this.config=config;this.active=active;this.restore=restore;}
  rememberForeground() {
    const fg=this.platform.foregroundApp();
    if(fg && fg.pid!==process.pid && !shell.has(fg.className))this.previous=fg;
  }
  target():CaptureTarget|null {
    this.rememberForeground();const rect=this.previous && this.platform.windowRect(this.previous.hwnd);
    const d=rect?screen.getDisplayMatching(screen.screenToDipRect(null,{x:rect.left,y:rect.top,width:rect.right-rect.left,height:rect.bottom-rect.top})):screen.getPrimaryDisplay();
    return {displayId:String(d.id)};
  }
  private permitted():boolean {
    if(!this.active() || !this.config().enabled)return false;
    const fg=this.platform.foregroundApp();
    const context=fg && (fg.pid===process.pid || shell.has(fg.className))?this.previous:fg;
    return !!context && !blockedApp(context.exe,this.config().blacklist);
  }
  async capture(target:CaptureTarget,scope:CaptureScope=this.config().scope):Promise<CapturedFrame> {
    if(scope!=='screen')throw new Error('capture-scope-not-implemented');
    if(!this.permitted() || !screen.getAllDisplays().some(d=>String(d.id)===target.displayId))throw new Error('capture-denied');
    const protectedWindows=new Map<BrowserWindow,boolean>();
    const protect=(w:BrowserWindow)=>{if(!w.isDestroyed()&&!protectedWindows.has(w)){protectedWindows.set(w,w.isContentProtected());w.setContentProtection(true);}};
    const onCreated=(_e:Electron.Event,w:BrowserWindow)=>protect(w);
    app.on('browser-window-created',onCreated);
    try {
      BrowserWindow.getAllWindows().forEach(protect);
      // Give DWM a composition turn before asking Chromium for the protected frame.
      await new Promise(r=>setTimeout(r,80));
      if(!this.permitted())throw new Error('capture-denied');
      const sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:1024,height:1024},fetchWindowIcons:false});
      if(!this.permitted())throw new Error('capture-denied');
      const source=sources.find(s=>s.display_id===target.displayId);if(!source || source.thumbnail.isEmpty())throw new Error('capture-unavailable');
      let img=source.thumbnail;let size=img.getSize();const scale=Math.min(1,1024/Math.max(size.width,size.height));
      if(scale<1)img=img.resize({width:Math.max(1,Math.round(size.width*scale)),height:Math.max(1,Math.round(size.height*scale))});
      size=img.getSize();const jpeg=img.toJPEG(70);if(!jpeg.length || jpeg.length>2*1024*1024)throw new Error('capture-unavailable');
      return {source:`显示器 ${target.displayId} 整屏`,capturedAt:Date.now(),fingerprint:`${target.displayId}:`+createHash('sha256').update(jpeg).digest('hex'),
        dataUrl:'data:image/jpeg;base64,'+jpeg.toString('base64'),width:size.width,height:size.height,
        valid:()=>this.permitted() && screen.getAllDisplays().some(d=>String(d.id)===target.displayId)};
    } finally {
      app.removeListener('browser-window-created',onCreated);
      for(const [w,was] of protectedWindows)if(!w.isDestroyed())w.setContentProtection(this.restore(w,was));
    }
  }
}
