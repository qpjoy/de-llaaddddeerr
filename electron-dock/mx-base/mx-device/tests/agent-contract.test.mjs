// SimDriver must pass the same conformance suite real drivers will.
import { SimDriver } from "../server/agent/sim-driver.mjs";
import { driverContract, gateContract } from "./agent-contract.mjs";

gateContract();
driverContract("SimDriver", (faults) => new SimDriver({ faults }), {
  serial: "sim-contract",
  apps: ["weibo", "xhs"],
});
