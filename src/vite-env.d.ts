/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

declare module '@ss/mtd-vue3' {
  const MTD: any;
  export default MTD;
}
