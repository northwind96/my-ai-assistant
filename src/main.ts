import { createApp } from "vue";
import App from "./App.vue";
// markdown渲染
import 'markstream-vue/index.css'
// 通用字体
import 'vfonts/Lato.css'
import 'vfonts/FiraCode.css'

const app = createApp(App);
app.mount("#app");
