import { createApp } from "vue";
import App from "./App.vue";
import { refresh } from "./store";
import "./styles.css";

createApp(App).mount("#app");
void refresh();
