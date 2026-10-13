import { ObserverAdapter, ObserverContext } from "../../packages/observers/src";
export const exampleObserver: ObserverAdapter = {
  id: "example",
  kind: "core",
  async ready() {
    return true;
  },
  async sample(_context: ObserverContext) {
    return [];
  }
};
