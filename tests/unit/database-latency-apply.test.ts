import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EXIT_FAILED,
  EXIT_UNSUPPORTED,
  applyLatency,
  classifyFailure,
  filterArgs,
  median,
  netemArgs,
  parseDelayMs,
  parseRouteDevice,
  prioArgs,
  probeLatency
} from "../../apps/observer/src/latency/apply";

describe("database latency tool", () => {
  it("builds the destination-filtered netem commands", () => {
    assert.deepEqual(prioArgs("eth0"), [
      "qdisc",
      "replace",
      "dev",
      "eth0",
      "root",
      "handle",
      "1:",
      "prio",
      "bands",
      "4",
      "priomap",
      "1",
      "1",
      "1",
      "1",
      "1",
      "1",
      "1",
      "1",
      "1",
      "1",
      "1",
      "1",
      "1",
      "1",
      "1",
      "1"
    ]);
    assert.deepEqual(netemArgs("eth0", 20), [
      "qdisc",
      "replace",
      "dev",
      "eth0",
      "parent",
      "1:4",
      "handle",
      "40:",
      "netem",
      "delay",
      "20ms"
    ]);
    assert.deepEqual(filterArgs("eth0", "172.18.0.4"), [
      "filter",
      "add",
      "dev",
      "eth0",
      "parent",
      "1:0",
      "protocol",
      "ip",
      "prio",
      "1",
      "u32",
      "match",
      "ip",
      "dst",
      "172.18.0.4/32",
      "flowid",
      "1:4"
    ]);
  });

  it("parses routes, medians, delays and failure classes", () => {
    assert.equal(parseRouteDevice("172.18.0.4 dev eth1 src 172.18.0.3 uid 0 \\    cache"), "eth1");
    assert.equal(parseRouteDevice("unreachable"), undefined);
    assert.equal(median([5, 1, 3]), 3);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(parseDelayMs("1"), 1);
    assert.equal(parseDelayMs("1000"), 1000);
    for (const bad of ["0", "1001", "2.5", "x", undefined])
      assert.throws(() => parseDelayMs(bad), /delay_ms_invalid/);
    assert.equal(classifyFailure("Error: Specified qdisc kind is unknown."), EXIT_UNSUPPORTED);
    assert.equal(
      classifyFailure('Unknown filter "u32", hence option "match" is unparsable'),
      EXIT_UNSUPPORTED
    );
    assert.equal(classifyFailure("RTNETLINK answers: Operation not permitted"), EXIT_FAILED);
  });

  it("applies one filter per peer IP and reports the qdisc", async () => {
    const calls: string[][] = [];
    const result = await applyLatency({
      delayMs: 20,
      peers: ["pas-1", "pas-2"],
      service: "database",
      lookup: async (name) => [name === "pas-1" ? "172.18.0.5" : "172.18.0.6"],
      run: async (file, args) => {
        calls.push([file, ...args]);
        if (file === "ip") return { stdout: "172.18.0.5 dev eth0 src 172.18.0.2", stderr: "" };
        if (args.includes("show") && args[0] === "-s")
          return { stdout: "qdisc netem 40: parent 1:4 limit 1000 delay 20ms", stderr: "" };
        return { stdout: "", stderr: "" };
      }
    });
    assert.equal(result.ok, true);
    assert.equal(result.device, "eth0");
    assert.deepEqual(result.peers, [
      { service: "pas-1", ip: "172.18.0.5" },
      { service: "pas-2", ip: "172.18.0.6" }
    ]);
    const tcCalls = calls.filter((call) => call[0] === "tc").map((call) => call.slice(1));
    assert.deepEqual(tcCalls[1], prioArgs("eth0"));
    assert.deepEqual(tcCalls[2], netemArgs("eth0", 20));
    assert.deepEqual(tcCalls[3], filterArgs("eth0", "172.18.0.5"));
    assert.deepEqual(tcCalls[4], filterArgs("eth0", "172.18.0.6"));
  });

  it("reports an unsupported kernel with exit code 2", async () => {
    const result = await applyLatency({
      delayMs: 5,
      peers: ["database"],
      lookup: async () => ["172.18.0.2"],
      run: async (file, args) => {
        if (file === "ip") return { stdout: "172.18.0.2 dev eth0", stderr: "" };
        if (args.includes("netem"))
          throw Object.assign(new Error("tc failed"), {
            stderr: "Error: Specified qdisc kind is unknown."
          });
        return { stdout: "", stderr: "" };
      }
    });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, EXIT_UNSUPPORTED);
  });

  it("probes by IP after one warm-up connect and reports the median", async () => {
    const samples = [99, 3, 1, 2, 5, 4];
    const hosts: string[] = [];
    const result = await probeLatency({
      target: "database:20931",
      lookup: async (name) => {
        assert.equal(name, "database");
        return "172.19.0.6";
      },
      connect: async (host, port) => {
        hosts.push(host);
        assert.equal(port, 20931);
        return samples.shift()!;
      }
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.samplesMs, [3, 1, 2, 5, 4]);
    assert.equal(result.medianMs, 3);
    assert.deepEqual([...new Set(hosts)], ["172.19.0.6"]);
    assert.equal(hosts.length, 6);
    assert.equal((await probeLatency({ target: "database" })).ok, false);
  });
});
