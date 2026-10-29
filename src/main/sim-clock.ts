// Active simulation time is separate from window/event timers and provider wall-clock deadlines.
export class SimClock {
  lastWall: number;
  private now: number;
  private running = true;
  private stallSec: number;
  private recoveryStepSec: number;
  constructor(wall: number, opts: {stallSec:number;recoveryStepSec:number}, initial = 0) {
    this.lastWall=wall;this.now=initial;this.stallSec=opts.stallSec;this.recoveryStepSec=opts.recoveryStepSec;
  }
  step(wall: number, running: boolean): {now:number;dt:number;stalled:number} {
    const elapsed=Math.max(0,wall-this.lastWall), wasRunning=this.running;
    this.lastWall=wall;this.running=running;
    const stalled=running&&wasRunning&&elapsed>this.stallSec?elapsed:0;
    const dt=!running||!wasRunning?0:stalled?this.recoveryStepSec:elapsed;
    this.now+=dt;
    return {now:this.now,dt,stalled};
  }
}
