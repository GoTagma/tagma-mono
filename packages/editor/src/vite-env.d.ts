/// <reference types="vite/client" />

declare module 'js-yaml' {
  export function dump(obj: unknown, opts?: { indent?: number; lineWidth?: number }): string;
  export function load(str: string): unknown;
  const yaml: { dump: typeof dump; load: typeof load };
  export default yaml;
}
