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

export interface MemoryTabCallbacks {
	onExport: () => void;
	onImport: (file: File) => Promise<void>;
}

// Export / import of the personal knowledge graph. Browser storage can be
// evicted, so a file export is the real durability story (the framework's
// PersistentStorageDialog is broken upstream). main.ts supplies the callbacks
// since the live graph lives there.
export class MemoryTab extends SettingsTab {
	constructor(private readonly cbs: MemoryTabCallbacks) {
		super();
	}

	getTabName(): string {
		return "Memory";
	}

	render(): TemplateResult {
		const onFile = async (e: Event) => {
			const input = e.target as HTMLInputElement;
			const file = input.files?.[0];
			input.value = "";
			if (!file) return;
			try {
				await this.cbs.onImport(file);
			} catch (err) {
				alert(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		};
		return html`
			<div class="flex flex-col gap-4 p-1">
				<p class="text-sm text-muted-foreground">
					Your personal knowledge graph lives only in this browser. Export it to back it up or move it
					to another device; import to restore. Browser storage can be cleared, so exporting is the
					real safety net.
				</p>
				<div class="flex gap-3">
					<button
						class="rounded border border-primary px-3 py-1.5 text-sm text-primary hover:opacity-80"
						@click=${() => this.cbs.onExport()}
					>
						Export memory
					</button>
					<label
						class="cursor-pointer rounded border border-border px-3 py-1.5 text-sm hover:opacity-80"
					>
						Import memory
						<input type="file" accept="application/json" class="hidden" @change=${onFile} />
					</label>
				</div>
			</div>
		`;
	}
}

if (!customElements.get("memory-tab")) {
	customElements.define("memory-tab", MemoryTab);
}
