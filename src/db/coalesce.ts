/**
 * Runs `task` for a key, one run at a time. A call that comes while a run is in progress is not dropped: the task runs once
 * more when that run is over, so the state after the last call is always the one the task has seen.
 */
export function coalesce(task: (key: string) => Promise<void>): (key: string) => Promise<void> {
  const running = new Set<string>();
  const again = new Set<string>();
  return async (key) => {
    if (running.has(key)) {
      again.add(key);
      return;
    }
    running.add(key);
    try {
      do {
        again.delete(key);
        await task(key);
      } while (again.has(key));
    } finally {
      running.delete(key);
    }
  };
}
