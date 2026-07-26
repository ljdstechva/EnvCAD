import { createApp } from 'vue'
import App from './App.vue'
import './style.css'
import { agentBridge } from './agent/bridge'
import { registerCadHandlers } from './agent/handlers'
import { installAgentTestHarness } from './agent/testHarness'

registerCadHandlers()
agentBridge.connect()
installAgentTestHarness()

createApp(App).mount('#app')
