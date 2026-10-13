import { parentPort, workerData } from "node:worker_threads";
import { runPoolSimulation } from "./pool-simulator.mjs";
try {
  parentPort.postMessage({ report: runPoolSimulation(workerData) });
} catch (error) {
  parentPort.postMessage({ error: error.message, status: error.status || 500 });
}
