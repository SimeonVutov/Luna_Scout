import { useEffect, useState } from "react";
import { skyBatch } from "../../api/client";
import type { SkySample, TimeRange } from "../../api/types";

// Where the Sun and Earth are at a given time never changes, so every view shares one memory.
const known = new Map<number, SkySample>();
const requested = new Set<string>();
/** Samples per batch on the API; only used to avoid asking for the same batch twice. */
const BATCH_SAMPLES = 32;

function remember(samples: SkySample[]) {
  for (const sample of samples) known.set(Date.parse(sample.at_utc), sample);
}

/**
 * Moon-centred Sun and Earth positions at snapshot `timeIndex` of the timeline, computed by the
 * API with SPICE. Positions arrive in the same batches the simulation uses, and the next batch is
 * fetched ahead of the playhead so playing the timeline does not wait.
 */
export function useSky(range: TimeRange, integrationMinutes: number, timeIndex: number, enabled: boolean) {
  const [, setLoaded] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const stride = range.snapshot_minutes / integrationMinutes;
  const sampleIndex = Math.round(timeIndex * stride);
  const at = Date.parse(range.start_utc) + sampleIndex * integrationMinutes * 60_000;
  const lastSample = Math.ceil((Date.parse(range.end_utc) - Date.parse(range.start_utc)) / (integrationMinutes * 60_000));

  useEffect(() => {
    if (!enabled || !Number.isInteger(stride)) return;
    let active = true;
    // The playhead's own batch, and the one after it.
    for (const index of [sampleIndex, Math.min(lastSample, sampleIndex + BATCH_SAMPLES)]) {
      const time = Date.parse(range.start_utc) + index * integrationMinutes * 60_000;
      const key = `${range.start_utc}|${range.end_utc}|${integrationMinutes}|${Math.floor(index / BATCH_SAMPLES)}`;
      if (known.has(time) || requested.has(key)) continue;

      requested.add(key);
      void skyBatch(range, integrationMinutes, index).then((batch) => {
        remember(batch.samples);
        if (active) {
          setError(null);
          setLoaded((count) => count + 1);
        }
      }).catch((failure) => {
        // Allow another attempt the next time this batch is needed.
        requested.delete(key);
        if (active && index === sampleIndex) setError(failure instanceof Error ? failure.message : "Could not load the Sun and Earth positions.");
      });
    }
    return () => { active = false; };
  }, [enabled, range, integrationMinutes, sampleIndex, lastSample, stride]);

  const sample = known.get(at) ?? null;
  return { sample, error: sample ? null : error };
}
