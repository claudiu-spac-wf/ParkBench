import test from "node:test";
import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import { IopsReadonlySession } from "../../packages/compose-runner/src/iops-readonly-session";
const frame = (text: string, stream = 1) => {
  const payload = Buffer.from(text),
    header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
};
class Connection extends Duplex {
  onToken?: (token: string) => void;
  _read() {}
  _write(data: Buffer, _encoding: any, done: () => void) {
    this.onToken?.(data.toString().trim());
    done();
  }
  _final(done: () => void) {
    this.push(null);
    done();
  }
  unref() {
    return this;
  }
}
test("idle worker performs one fresh tokenized read and accepts split Docker frames", async () => {
  const socket = new Connection();
  const session = new IopsReadonlySession(socket as any, "b".repeat(64));
  let count = 0;
  socket.onToken = (token) => {
    count++;
    const data = frame(`OWNER\towned\n\nIOPS_END\t${token}\t0\n`);
    socket.push(data.subarray(0, 5));
    socket.push(data.subarray(5));
  };
  assert.equal(count, 0);
  assert.equal(await session.request(Date.now() + 500), "OWNER\towned\n");
  assert.equal(await session.request(Date.now() + 500), "OWNER\towned\n");
  assert.equal(count, 2);
  session.close();
});
test("worker refuses overlapping checks, deadlines and late replies", async () => {
  const socket = new Connection(),
    session = new IopsReadonlySession(socket as any, "b".repeat(64));
  const first = session.request(Date.now() + 20);
  await assert.rejects(session.request(Date.now() + 100), /busy/);
  await assert.rejects(first, /deadline/);
  socket.push(frame("\nIOPS_END\t1\t0\n"));
  await assert.rejects(session.request(Date.now() + 100), /unavailable/);
});
for (const kind of ["stderr", "bad-frame", "oversized", "failed-receipt"])
  test(`worker rejects ${kind} without retaining raw output`, async () => {
    const socket = new Connection(),
      session = new IopsReadonlySession(socket as any, "b".repeat(64));
    socket.onToken = (token) => {
      let data = frame(`private-secret\n\nIOPS_END\t${token}\t0\n`, kind === "stderr" ? 2 : 1);
      if (kind === "bad-frame") data[0] = 9;
      if (kind === "oversized") data.writeUInt32BE(1048577, 4);
      if (kind === "failed-receipt") data = frame(`\nIOPS_END\t${token}\t25\n`);
      socket.push(data);
    };
    await assert.rejects(session.request(Date.now() + 500), (error) => {
      assert.match(String(error), /unconfirmed/);
      assert.ok(!String(error).includes("private-secret"));
      return true;
    });
  });
