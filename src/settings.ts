import { SettingsTab } from "@earendil-works/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { state } from "lit/decorators.js";

export interface MemoryTabCallbacks {
	isEnabled: () => boolean;
	setEnabled: (on: boolean) => Promise<void>;
}

// The Memory tab: turn personal-graph memory on or off after the initial consent
// prompt. Off means nothing new is ingested; the existing graph is untouched (back
// it up from Export). This is the "change your mind later" half of the consent gate.
export class MemoryTab extends SettingsTab {
	@state() private enabled = false;

	constructor(private readonly cbs: MemoryTabCallbacks) {
		super();
		this.enabled = cbs.isEnabled();
	}

	getTabName(): string {
		return "Memory";
	}

	render(): TemplateResult {
		const toggle = async () => {
			const next = !this.enabled;
			await this.cbs.setEnabled(next);
			this.enabled = next;
		};
		return html`
			<div class="flex flex-col gap-4 p-1">
				<p class="text-sm text-muted-foreground">
					Cymbiont remembers your conversations as a personal knowledge graph, kept only in this browser.
				</p>
				<div class="flex items-center gap-3">
					<button
						class="rounded border border-primary px-3 py-1.5 text-sm text-primary hover:opacity-80"
						@click=${toggle}
					>
						${this.enabled ? "Turn memory off" : "Turn memory on"}
					</button>
					<span class="text-sm text-muted-foreground">
						Memory is <span class="text-primary">${this.enabled ? "on" : "off"}</span>.
					</span>
				</div>
			</div>
		`;
	}
}

if (!customElements.get("memory-tab")) {
	customElements.define("memory-tab", MemoryTab);
}

export interface ExportTabCallbacks {
	onExport: () => void;
	onImport: (file: File) => Promise<void>;
	onDelete: () => Promise<void>;
}

// Export / import of the personal knowledge graph. Browser storage can be
// evicted, so a file export is the real durability story (the framework's
// PersistentStorageDialog is broken upstream). main.ts supplies the callbacks
// since the live graph lives there.
export class ExportTab extends SettingsTab {
	constructor(private readonly cbs: ExportTabCallbacks) {
		super();
	}

	getTabName(): string {
		return "Export";
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
		const onDelete = async () => {
			if (!confirm("Delete your knowledge graph? This can't be undone.")) return;
			await this.cbs.onDelete();
			alert("Your knowledge graph has been deleted.");
		};
		return html`
			<div class="flex flex-col gap-4 p-1">
				<p class="text-sm text-muted-foreground">
					Save your memory to a file you can re-import later or move to another browser.
				</p>
				<div class="flex flex-wrap gap-3">
					<button
						class="rounded border border-primary px-3 py-1.5 text-sm text-primary hover:opacity-80"
						@click=${() => this.cbs.onExport()}
					>
						Export
					</button>
					<label
						class="cursor-pointer rounded border border-primary px-3 py-1.5 text-sm text-primary hover:opacity-80"
					>
						Import
						<input type="file" accept="application/json" class="hidden" @change=${onFile} />
					</label>
					<button
						class="rounded border border-red-400 px-3 py-1.5 text-sm text-red-400 hover:opacity-80"
						@click=${onDelete}
					>
						Delete
					</button>
				</div>
			</div>
		`;
	}
}

if (!customElements.get("export-tab")) {
	customElements.define("export-tab", ExportTab);
}
