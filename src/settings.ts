import { SettingsTab } from "@earendil-works/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { state } from "lit/decorators.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";

export interface MemoryTabCallbacks {
	isEnabled: () => boolean;
	setEnabled: (on: boolean) => Promise<void>;
	onExport: () => void;
	onImport: (file: File) => Promise<void>;
	onDelete: () => Promise<void>;
}

// The Memory tab: the single home for memory in Settings — turn it on or off after
// the initial consent prompt, and export / import / delete the stored lexicon (the
// whole memory artifact — the term glossary plus speech-adaptation data and
// conversation summaries; there is nothing else to export). Off means the pipeline
// never fires; existing memory is untouched. Browser storage can be evicted, so the
// file export is the real durability story (the framework's PersistentStorageDialog
// is broken upstream). main.ts supplies the callbacks since the live stores live there.
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
			if (!confirm("Delete your memory? This can't be undone.")) return;
			await this.cbs.onDelete();
			alert("Your memory has been deleted.");
		};
		return html`
			<div class="flex flex-col gap-4 p-1">
				<p class="text-sm text-muted-foreground">
					Myriapod remembers your conversations as a personal memory, kept only in this browser.
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
				<hr class="border-border" />
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

if (!customElements.get("memory-tab")) {
	customElements.define("memory-tab", MemoryTab);
}

// The Access tab: bring your own OpenRouter key, plus a quiet, discrete section to
// apply a credit code (the privileged family tier — deliberately unbranded; normal
// visitors aren't meant to know it exists).
//
// The key field is our own password-masked input (NOT the stock <provider-key-input>,
// which renders a non-editable masked blob you can't clear). Clearing the field and
// pressing Save removes the key in place — the convention, no separate delete button.
// Storage lives in main.ts via the callbacks.
export interface OpenRouterKeyTabCallbacks {
	currentKey: string; // the OpenRouter key currently stored (may be "")
	onSaveKey: (key: string) => Promise<void>; // empty string → remove the key
	onRedeem: (code: string) => Promise<{ ok: boolean; error?: string }>;
	// Remaining hosted credit for the readout; null on the own-key path.
	getBalance: () => Promise<{ tier: string; remaining: number; grant: number } | null>;
}

export class OpenRouterKeyTab extends SettingsTab {
	@state() private keyValue = "";
	@state() private codeValue = "";
	@state() private balance: { tier: string; remaining: number; grant: number } | null = null;
	@state() private busy = false;

	constructor(private readonly cbs: OpenRouterKeyTabCallbacks) {
		super();
		this.keyValue = cbs.currentKey ?? "";
	}

	async connectedCallback(): Promise<void> {
		super.connectedCallback();
		this.balance = await this.cbs.getBalance();
	}

	getTabName(): string {
		return "Access";
	}

	render(): TemplateResult {
		const saveKey = async () => {
			if (this.busy) return;
			this.busy = true;
			try {
				const key = this.keyValue.trim();
				await this.cbs.onSaveKey(key);
				alert(key ? "Key saved." : "Key removed — you're back on the free tier.");
			} finally {
				this.busy = false;
			}
		};
		const redeem = async () => {
			if (this.busy) return;
			const code = this.codeValue.trim();
			if (!code) return;
			this.busy = true;
			try {
				const res = await this.cbs.onRedeem(code);
				if (res.ok) {
					this.codeValue = "";
					// Refresh the readout — the captured balance is now stale post-redeem.
					if (this.cbs.getBalance) this.balance = await this.cbs.getBalance();
					alert("Credit applied! Start a new chat to use it.");
				} else {
					alert(`Could not apply code: ${res.error ?? "unknown error"}`);
				}
			} finally {
				this.busy = false;
			}
		};
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
					directly to OpenRouter. Clear it and Save to remove it and return to the free credits.
				</p>
				<div class="flex items-center gap-2">
					${Input({
						type: "password",
						value: this.keyValue,
						placeholder: "sk-or-...",
						className: "flex-1",
						onInput: (e: Event) => {
							this.keyValue = (e.target as HTMLInputElement).value;
						},
					})}
					<button
						class="rounded border border-primary px-3 py-1.5 text-sm text-primary hover:opacity-80 disabled:opacity-50"
						?disabled=${this.busy}
						@click=${saveKey}
					>
						Save
					</button>
				</div>
				<hr class="border-border" />
				<div class="flex flex-col gap-2">
					<p class="text-sm text-muted-foreground">
						Have a credit code? Apply it for hosted credits — no key needed.
					</p>
					<div class="flex items-center gap-2">
						${Input({
							type: "text",
							value: this.codeValue,
							placeholder: "credit code",
							className: "flex-1",
							onInput: (e: Event) => {
								this.codeValue = (e.target as HTMLInputElement).value;
							},
						})}
						<button
							class="rounded border border-primary px-3 py-1.5 text-sm text-primary hover:opacity-80 disabled:opacity-50"
							?disabled=${this.busy}
							@click=${redeem}
						>
							Apply
						</button>
					</div>
				</div>
				${
					this.balance
						? html`
							<hr class="border-border" />
							<p class="text-sm text-muted-foreground">
								${this.balance.tier === "family" ? "Credit" : "Free credit"}:
								<span class="text-primary"
									>$${Number.isFinite(this.balance.remaining) ? this.balance.remaining.toFixed(4) : "—"}</span
								>
								of $${Number.isFinite(this.balance.grant) ? this.balance.grant.toFixed(2) : "—"} remaining
							</p>
						`
						: null
				}
			</div>
		`;
	}
}

// SettingsDialog renders tab instances directly into a lit template (`${tab}`), which
// requires the element to be a defined custom element.
if (!customElements.get("openrouter-key-tab")) {
	customElements.define("openrouter-key-tab", OpenRouterKeyTab);
}
