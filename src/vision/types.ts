// Capture policy is independent of characters and providers. Reserved modes have no implementation yet.
export type CaptureScope = 'screen' | 'window' | 'prefer-window';
export interface CaptureTarget { displayId: string; /** Reserved window identity for future window strategies. */ window?: {hwnd:number;pid:number} }
export interface CapturedFrame {
  source: string; capturedAt: number; fingerprint: string; dataUrl: string; width: number; height: number;
  /** Recheck capture permission immediately before sending; never interpret an old image as live. */
  valid: () => boolean;
}
export interface VisionConfig {
  enabled: boolean; auto: boolean; scope: CaptureScope; intervalSec: number; staggerSec: number; blacklist: string[];
}
export interface CharacterVision { auto?: boolean; intervalSec?: number }
export const DEFAULT_VISION: VisionConfig = {enabled:false, auto:false, scope:'screen', intervalSec:600, staggerSec:15,
  blacklist:['1password.exe','bitwarden.exe','keepass.exe','keepassxc.exe','lastpass.exe','wechat.exe','weixin.exe','qq.exe','telegram.exe','signal.exe']};
export const intervalValid = (n: unknown): n is number => typeof n==='number' && Number.isFinite(n) && n>=5 && n<=86400;
export function characterVisionValid(v: CharacterVision): boolean {
  return !!v && typeof v==='object' && !Array.isArray(v) && Object.keys(v).every(k=>['auto','intervalSec'].includes(k)) &&
    (v.auto===undefined || typeof v.auto==='boolean') && (v.intervalSec===undefined || intervalValid(v.intervalSec));
}
export function visionValid(v: VisionConfig): boolean {
  return !!v && typeof v==='object' && typeof v.enabled==='boolean' && typeof v.auto==='boolean' && v.scope==='screen' && intervalValid(v.intervalSec) &&
    typeof v.staggerSec==='number' && Number.isFinite(v.staggerSec) && v.staggerSec>=0 && v.staggerSec<=3600 && Array.isArray(v.blacklist) &&
    v.blacklist.length<=200 && v.blacklist.every(x=>typeof x==='string' && /^[\w. -]{1,100}\.exe$/i.test(x));
}
export const blockedApp = (exe: string, list: readonly string[]) => !exe || list.some(x=>x.toLowerCase()===exe.toLowerCase());
