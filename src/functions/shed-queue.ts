// Runs tasks one at a time in arrival order and skips one that waited longer
// than `maxWaitMs`. A burst of requests served together finishes together, every
// one of them late; served in turn, the first ones answer in time, and a request
// whose caller has already given up is not computed at all.
export type Turn<T> = { shed: true } | { shed: false; value: T };

export class ShedQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  private shedCount = 0;

  constructor(
    private readonly maxWaitMs: number,
    private readonly now: () => number = () => performance.now(),
  ) {}

  get shed(): number {
    return this.shedCount;
  }

  get depth(): number {
    return this.waiting;
  }

  async run<T>(task: () => Promise<T>): Promise<Turn<T>> {
    const queuedAt = this.now();
    this.waiting++;
    const turn = this.tail.then((): Turn<T> | Promise<Turn<T>> => {
      this.waiting--;
      if (this.now() - queuedAt > this.maxWaitMs) {
        this.shedCount++;
        return { shed: true };
      }
      return task().then((value) => ({ shed: false, value }));
    });
    this.tail = turn.catch(() => {});
    return turn;
  }
}
