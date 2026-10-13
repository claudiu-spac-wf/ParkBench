export class FakeOpenEdge {
  dbReady = true;
  pasReady = true;
  calls: string[] = [];
  async databaseReady(): Promise<boolean> {
    this.calls.push("databaseReady");
    return this.dbReady;
  }
  async pasReplicaReady(_replica: number): Promise<boolean> {
    this.calls.push("pasReplicaReady");
    return this.pasReady;
  }
  async sampleDatabase(): Promise<number> {
    this.calls.push("sampleDatabase");
    return 1;
  }
  async samplePas(): Promise<Record<string, number>> {
    this.calls.push("samplePas");
    return { requests: 1, active: 0 };
  }
}
