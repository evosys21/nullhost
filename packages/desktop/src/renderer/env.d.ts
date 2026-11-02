/// <reference types="vite/client" />
import type { NullhostApi } from "../shared/api";

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<object, object, unknown>;
  export default component;
}

declare global {
  interface Window {
    nullhost?: NullhostApi;
    /** smoke tests switch screens through this */
    __nullhostNav?: (screen: string) => void;
  }
}
