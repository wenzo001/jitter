import { createApp } from 'vue'
import { createPinia } from 'pinia'
import 'antdv-next/dist/reset.css'
import './styles.css'
import App from './App.vue'

createApp(App).use(createPinia()).mount('#app')
