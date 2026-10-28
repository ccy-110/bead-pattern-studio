import { createApp } from 'vue'
import App from './App.vue'
import { init as initCloud } from './stores/cloud'
import './styles/main.css'

createApp(App).mount('#app')

/**
 * 账号与分享链接的初始化。
 *
 * 放在这里而不是 `App.vue` 的 onMounted：组件测试会直接 mount App / 各个面板，
 * 那里面不该发出真实网络请求。`main.ts` 只在真正的应用启动时执行。
 *
 * `init()` 内部吞掉了"后端没启动"的情况 —— 云端不可用不影响本地使用。
 */
void initCloud()
