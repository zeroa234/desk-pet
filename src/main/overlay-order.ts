// Policy only: ordinary windows must not outrank a free overlay. Intentional topmost covers stay above it.
import type {WinInfo} from '../shared/types.ts';
export interface OverlayOrderRepair {reason:'lost-topmost'|'ordinary-above';below:number|null}
/** above is nearest first, as returned by Platform.windowsAbove, already filtered to known user windows. */
export function overlayOrderRepair(topmost:boolean,above:readonly Pick<WinInfo,'hwnd'|'topmost'>[]):OverlayOrderRepair|null {
  if(topmost && !above.some(w=>!w.topmost))return null;
  return {reason:topmost?'ordinary-above':'lost-topmost',below:above.find(w=>w.topmost)?.hwnd??null};
}
