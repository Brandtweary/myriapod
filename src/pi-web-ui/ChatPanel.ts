import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import "./components/AgentInterface.js";
import type { Agent, AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentInterface } from "./components/AgentInterface.js";

@customElement("pi-chat-panel")
export class ChatPanel extends LitElement {
	@state() public agent?: Agent;
	@state() public agentInterface?: AgentInterface;

	createRenderRoot() {
		return this;
	}

	override connectedCallback() {
		super.connectedCallback();
		this.style.display = "flex";
		this.style.flexDirection = "column";
		this.style.height = "100%";
		this.style.minHeight = "0";
	}

	async setAgent(
		agent: Agent,
		config?: {
			onApiKeyRequired?: (provider: string) => Promise<boolean>;
			onBeforeSend?: () => void | Promise<void>;
			onCostClick?: () => void;
			onModelSelect?: () => void;
			toolsFactory?: (agent: Agent, agentInterface: AgentInterface) => AgentTool<any>[];
		},
	) {
		this.agent = agent;

		// Create AgentInterface
		this.agentInterface = document.createElement("agent-interface") as AgentInterface;
		this.agentInterface.session = agent;
		this.agentInterface.enableModelSelector = true;
		this.agentInterface.enableThinkingSelector = true;
		this.agentInterface.showThemeToggle = false;
		this.agentInterface.onApiKeyRequired = config?.onApiKeyRequired;
		this.agentInterface.onModelSelect = config?.onModelSelect;
		this.agentInterface.onBeforeSend = config?.onBeforeSend;
		this.agentInterface.onCostClick = config?.onCostClick;

		// Set tools on the agent from the consumer's factory.
		this.agent.state.tools = config?.toolsFactory?.(agent, this.agentInterface) ?? [];

		this.requestUpdate();
	}

	render() {
		if (!this.agent || !this.agentInterface) {
			return html`<div class="flex items-center justify-center h-full">
				<div class="text-muted-foreground">No agent set</div>
			</div>`;
		}

		return html`
			<div class="relative w-full h-full overflow-hidden flex">
				<div class="h-full" style="width: 100%;">${this.agentInterface}</div>
			</div>
		`;
	}
}
