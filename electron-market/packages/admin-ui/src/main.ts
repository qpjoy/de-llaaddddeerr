import { createApp } from 'vue';
import { Quasar, Notify, Dialog } from 'quasar';

import 'quasar/dist/quasar.css';
import '@quasar/extras/material-icons/material-icons.css';
import './css/app.scss';

import App from './App.vue';
import { router } from './router';

const app = createApp(App);
app.use(Quasar, { plugins: { Notify, Dialog } });
app.use(router);
app.mount('#app');
