declare module "node:fs" {
  const value: any;
  export = value;
  export default value;
}
declare module "node:path" {
  const value: any;
  export = value;
  export default value;
}
declare module "node:crypto" {
  const value: any;
  export = value;
  export default value;
  export const randomUUID: any;
}
declare module "node:zlib" {
  const value: any;
  export = value;
  export default value;
}
declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(file: string);
    exec(sql: string): any;
    prepare(sql: string): any;
    close(): void;
  }
}
declare module "node:http" {
  const value: any;
  export = value;
  export default value;
}
declare module "node:url" {
  export const URL: any;
}
declare module "node:os" {
  const value: any;
  export = value;
  export default value;
}
declare module "node:test" {
  export const describe: any;
  export const it: any;
  export const test: any;
}
declare module "node:assert" {
  const value: any;
  export = value;
  export default value;
}
declare module "react" {
  const React: any;
  export default React;
  export const useEffect: any;
  export const useState: any;
  export const useRef: any;
}
declare module "react-dom/client" {
  export const createRoot: any;
}
declare module "react/jsx-runtime" {
  export const jsx: any;
  export const jsxs: any;
  export const Fragment: any;
}
declare module "fastify" {
  const Fastify: any;
  export default Fastify;
}
declare module "@fastify/cors" {
  const cors: any;
  export default cors;
}
declare var require: any;
declare var module: any;
declare var __dirname: string;
declare var process: any;
declare namespace NodeJS {
  type ProcessEnv = Record<string, string | undefined>;
}
declare var Buffer: any;
declare type Buffer = any;
declare namespace JSX {
  interface IntrinsicElements {
    [element: string]: any;
  }
}
