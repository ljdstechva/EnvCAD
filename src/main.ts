import { createApp } from 'vue'
import App from './App.vue'
import './style.css'
import { connectAgentBridge } from './agent/desktopRuntime'
import { registerCadHandlers } from './agent/handlers'
import { installAgentTestHarness } from './agent/testHarness'

registerCadHandlers()
void connectAgentBridge()
installAgentTestHarness()

createApp(App).mount('#app')
