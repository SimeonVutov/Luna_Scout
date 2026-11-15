import { useCallback, useEffect, useState } from "react";
import { ApiError, listRuns } from "../../api/client";
import type { RunList } from "../../api/types";

const busyInterval = 2_000;
const idleInterval = 8_000;

/**
 * Recent runs and the worker's state, fetched as soon as the page opens and refreshed while
 * anything is running, so reloading the page always shows the real current progress.
 */
export type ApiProblem = "unreachable" | "outdated" | null;

export function useActivity() {
  const [list, setList] = useState<RunList | null>(null);
  const [problem, setProblem] = useState<ApiProblem>(null);
  const busy = list?.runs.some((run) => run.stage === "queued" || run.stage === "running") ?? false;

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await listRuns(signal ?? new AbortController().signal);
      setList(next);
      setProblem(null);
    } catch (failure) {
      if (signal?.aborted) return;
      // 404 or 405 means a server answered but predates this endpoint; it only needs a restart.
      const answered = failure instanceof ApiError && (failure.status === 404 || failure.status === 405);
      setProblem(answered ? "outdated" : "unreachable");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = window.setInterval(() => void refresh(controller.signal), busy ? busyInterval : idleInterval);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [busy, refresh]);

  return { list, problem, refresh };
}
