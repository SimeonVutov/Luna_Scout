/** A job waiting to load. Lower `priority` loads sooner; `stale` jobs are dropped unstarted. */
export type Job = {
  priority: number;
  stale: () => boolean;
  run: () => Promise<void>;
  dropped: () => void;
};

/**
 * Runs a limited number of downloads at once, nearest first. The view asks for far more
 * tiles while the camera moves than are still wanted a moment later, so anything that became
 * stale while it waited is dropped instead of downloaded.
 */
export class LoadQueue {
  private waiting = new Set<Job>();
  private running = 0;

  constructor(private readonly limit: number) {}

  add(job: Job) {
    this.waiting.add(job);
    this.pump();
  }

  private pump() {
    while (this.running < this.limit && this.waiting.size) {
      let next: Job | null = null;
      for (const job of this.waiting) {
        if (job.stale()) {
          this.waiting.delete(job);
          job.dropped();
        } else if (!next || job.priority < next.priority) {
          next = job;
        }
      }
      if (!next) return;

      this.waiting.delete(next);
      this.running++;
      void next.run().finally(() => {
        this.running--;
        this.pump();
      });
    }
  }
}
