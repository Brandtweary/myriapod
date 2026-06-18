import { ProviderKeyInput, SettingsTab } from "@earendil-works/pi-web-ui";
import { html, type TemplateResult } from "lit";

// Referencing ProviderKeyInput ensures the module's side-effect customElement
// registration of <provider-key-input> runs even though we don't construct it
// directly (we use it in the lit template below).
void ProviderKeyInput;

// A deliberately minimal settings tab: ONLY the OpenRouter API-key field.
//
// The stock pi-web-ui tabs (ProvidersModelsTab, ApiKeysTab) enumerate every
// known provider and, in the case of ProvidersModelsTab, custom-provider
// machinery. Cymbiont Web supports exactly one bring-your-own-key path —
// OpenRouter — so we render a single provider-key-input and nothing else.
export class OpenRouterKeyTab extends SettingsTab {
	getTabName(): string {
		return "API Key";
	}

	render(): TemplateResult {
		return html`
			<div class="flex flex-col gap-4 p-1">
				<p class="text-sm text-muted-foreground">
					Optional: bring your own
					<a
						class="text-primary underline hover:opacity-80"
						href="https://openrouter.ai/"
						target="_blank"
						rel="noreferrer"
						>OpenRouter</a
					>
					API key to chat on your own credits. The key is stored only in this browser and is sent
					directly to OpenRouter. Leave this blank to use the hosted free credits.
				</p>
				<provider-key-input .provider=${"openrouter"}></provider-key-input>
			</div>
		`;
	}
}

// SettingsDialog renders tab instances directly into a lit template (`${tab}`),
// which requires the element to be a defined custom element.
if (!customElements.get("openrouter-key-tab")) {
	customElements.define("openrouter-key-tab", OpenRouterKeyTab);
}
