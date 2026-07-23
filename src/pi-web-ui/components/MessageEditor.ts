import type { Model } from "@earendil-works/pi-ai";
import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Select, type SelectOption } from "@mariozechner/mini-lit/dist/Select.js";
import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { createRef, ref } from "lit/directives/ref.js";
import { Brain, Send, Sparkles, Square } from "lucide";
import type { Attachment } from "../utils/attachment-types.js";
import { i18n } from "../utils/i18n.js";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

@customElement("message-editor")
export class MessageEditor extends LitElement {
	private _value = "";
	private textareaRef = createRef<HTMLTextAreaElement>();

	@property()
	get value() {
		return this._value;
	}

	set value(val: string) {
		const oldValue = this._value;
		this._value = val;
		this.requestUpdate("value", oldValue);
	}

	@property() isStreaming = false;
	@property() currentModel?: Model<any>;
	@property() thinkingLevel: ThinkingLevel = "off";
	@property() showModelSelector = true;
	@property() showThinkingSelector = true;
	@property() onInput?: (value: string) => void;
	@property() onSend?: (input: string, attachments: Attachment[]) => void;
	@property() onAbort?: () => void;
	@property() onModelSelect?: () => void;
	@property() onThinkingChange?: (level: "off" | "minimal" | "low" | "medium" | "high") => void;
	// File attachments are not supported in this build; the property survives so
	// the message model (user-with-attachments) stays type-compatible.
	@property() attachments: Attachment[] = [];

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	private handleTextareaInput = (e: Event) => {
		const textarea = e.target as HTMLTextAreaElement;
		this.value = textarea.value;
		this.onInput?.(this.value);
	};

	private handleKeyDown = (e: KeyboardEvent) => {
		// Ignore key events during IME composition (e.g. CJK input)
		if (e.isComposing || e.key === "Process") return;

		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			if (!this.isStreaming && this.value.trim()) {
				this.handleSend();
			}
		} else if (e.key === "Escape" && this.isStreaming) {
			e.preventDefault();
			this.onAbort?.();
		}
	};

	private handleSend = () => {
		this.onSend?.(this.value, this.attachments);
	};

	override firstUpdated() {
		const textarea = this.textareaRef.value;
		if (textarea) {
			textarea.focus();
		}
	}

	override render() {
		// Check if current model supports thinking/reasoning
		const model = this.currentModel;
		const supportsThinking = model?.reasoning === true; // Models with reasoning:true support thinking

		return html`
			<div class="bg-card rounded-xl border border-border shadow-sm relative">
				<textarea
					class="w-full bg-transparent p-4 text-foreground placeholder-muted-foreground outline-none resize-none overflow-y-auto"
					placeholder=${i18n("Type a message...")}
					rows="1"
					style="max-height: 200px; field-sizing: content; min-height: 1lh; height: auto;"
					.value=${this.value}
					@input=${this.handleTextareaInput}
					@keydown=${this.handleKeyDown}
					${ref(this.textareaRef)}
				></textarea>

				<!-- Button Row -->
				<div class="px-2 pb-2 flex items-center justify-between">
					<!-- Left side - thinking selector -->
					<div class="flex gap-2 items-center">
						${
							supportsThinking && this.showThinkingSelector
								? html`
									${Select({
										value: this.thinkingLevel,
										placeholder: i18n("Off"),
										options: [
											{ value: "off", label: i18n("Off"), icon: icon(Brain, "sm") },
											{ value: "minimal", label: i18n("Minimal"), icon: icon(Brain, "sm") },
											{ value: "low", label: i18n("Low"), icon: icon(Brain, "sm") },
											{ value: "medium", label: i18n("Medium"), icon: icon(Brain, "sm") },
											{ value: "high", label: i18n("High"), icon: icon(Brain, "sm") },
										] as SelectOption[],
										onChange: (value: string) => {
											const level = value as "off" | "minimal" | "low" | "medium" | "high";
											this.thinkingLevel = level;
											this.onThinkingChange?.(level);
										},
										width: "80px",
										size: "sm",
										variant: "ghost",
										fitContent: true,
									})}
								`
								: ""
						}
					</div>

					<!-- Model selector and send on the right -->
					<div class="flex gap-2 items-center">
						${
							this.showModelSelector && this.currentModel
								? html`
									${Button({
										variant: "ghost",
										size: "sm",
										onClick: () => {
											// Focus textarea before opening model selector so focus returns there
											this.textareaRef.value?.focus();
											// Wait for next frame to ensure focus takes effect before dialog captures it
											requestAnimationFrame(() => {
												this.onModelSelect?.();
											});
										},
										children: html`
											${icon(Sparkles, "sm")}
											<span class="ml-1">${this.currentModel.id}</span>
										`,
										className: "h-8 text-xs truncate",
									})}
								`
								: ""
						}
						${
							this.isStreaming
								? html`
									${Button({
										variant: "ghost",
										size: "icon",
										onClick: this.onAbort,
										children: icon(Square, "sm"),
										className: "h-8 w-8",
									})}
								`
								: html`
									${Button({
										variant: "ghost",
										size: "icon",
										onClick: this.handleSend,
										disabled: !this.value.trim(),
										children: html`<div style="transform: rotate(-45deg)">${icon(Send, "sm")}</div>`,
										className: "h-8 w-8",
									})}
								`
						}
					</div>
				</div>
			</div>
		`;
	}
}
