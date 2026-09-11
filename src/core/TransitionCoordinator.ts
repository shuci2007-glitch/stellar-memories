/** One cancellation generation for navigation, async photo loads and exit completion. */
export class TransitionCoordinator {
  private generation=0;
  private timers=new Set<ReturnType<typeof setTimeout>>();
  cancel() { this.generation++; for(const timer of this.timers)clearTimeout(timer);this.timers.clear();return this.generation; }
  current(token: number) { return token===this.generation; }
  after(token: number, duration: number, done:()=>void) {
    const timer=setTimeout(()=>{this.timers.delete(timer);if(this.current(token)) done();},duration);
    this.timers.add(timer);
  }
}
