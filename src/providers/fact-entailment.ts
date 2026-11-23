import { isAbsolute } from "node:path";
import { Worker } from "node:worker_threads";
import { logger } from "../logger.js";

const TIMEOUT_MS = 10_000;

export function createFactEntailmentVerifier(directory: string | undefined) {
  if (!directory) return undefined;
  if (!isAbsolute(directory)) {
    logger.warn("Fact entailment model directory must be absolute; cross-key merging disabled");
    return undefined;
  }
  let worker: Worker | undefined;
  let disabled = false;
  let pending: ((result: boolean) => void) | undefined;

  const disable = () => {
    if (disabled) return;
    disabled = true;
    logger.warn("Fact entailment worker unavailable; cross-key merging disabled until restart");
    pending?.(false);
    void worker?.terminate().catch(() => {});
  };

  return async (left: string, right: string): Promise<boolean> => {
    if (disabled || pending) return false;
    try {
      if (!worker) {
        const ext = import.meta.url.endsWith(".ts") ? "ts" : "mjs";
        worker = new Worker(new URL(`./fact-entailment-worker.${ext}`, import.meta.url), { workerData: directory });
        worker.on("error", disable);
        worker.on("exit", disable);
        worker.on("message", (result: unknown) => pending?.(result === true));
      }
      const target = worker;
      return await new Promise<boolean>((resolve) => {
        const timer = setTimeout(disable, TIMEOUT_MS);
        pending = (result) => {
          pending = undefined;
          clearTimeout(timer);
          target.unref();
          resolve(result);
        };
        target.ref();
        try {
          target.postMessage([left, right]);
        } catch {
          disable();
        }
      });
    } catch {
      disable();
      return false;
    }
  };
}
