import type { CompactionSummaryMessage } from "@earendil-works/pi-agent-core";
import { COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentMessage, MessageRenderer } from "@earendil-works/pi-web-ui";
import { defaultConvertToLlm, registerMessageRenderer } from "@earendil-works/pi-web-ui";
import { Alert } from "@mariozechner/mini-lit/dist/Alert.js";
import { html } from "lit";

// ============================================================================
// 1. EXTEND AppMessage TYPE VIA DECLARATION MERGING
// ============================================================================

// Define custom message types
export interface SystemNotificationMessage {
	role: "system-notification";
	message: string;
	variant: "default" | "destructive";
	timestamp: string;
}

// Hidden KG-context breadcrumb. Carries the per-turn <kg-context> injection block.
// Deliberately has NO registered renderer, so MessageList skips it (invisible in
// the chat) — but it persists in agent.state.messages and accumulates across
// turns, mirroring Claude Code's accumulating additionalContext. convertToLlm
// converts it to a real user message so the model sees the retrieved context.
export interface KgContextMessage {
	role: "kg-context";
	block: string;
	timestamp: string;
}

// Recording-in-progress placeholder. Inserted on the user side at mic record-start
// and removed at record-stop (the real transcript bubble then lands via agent.prompt).
// Purely a visual cue — it carries no content and is deliberately given NO case in
// customConvertToLlm, so defaultConvertToLlm drops it (the model never sees it).
export interface VoicePendingMessage {
	role: "voice-pending";
	timestamp: string;
}

// Extend CustomAgentMessages interface via declaration merging
// This must target pi-agent-core where CustomAgentMessages is defined.
// (compactionSummary is already declared by pi-agent-core's harness/messages; we only
// add a customConvertToLlm case for it below.)
declare module "@earendil-works/pi-agent-core" {
	interface CustomAgentMessages {
		"system-notification": SystemNotificationMessage;
		"kg-context": KgContextMessage;
		"voice-pending": VoicePendingMessage;
	}
}

export function createKgContextMessage(block: string): KgContextMessage {
	return { role: "kg-context", block, timestamp: new Date().toISOString() };
}

export function createVoicePendingMessage(): VoicePendingMessage {
	return { role: "voice-pending", timestamp: new Date().toISOString() };
}

// ============================================================================
// 2. CREATE CUSTOM RENDERER (TYPED TO SystemNotificationMessage)
// ============================================================================

const systemNotificationRenderer: MessageRenderer<SystemNotificationMessage> = {
	render: (notification) => {
		// notification is fully typed as SystemNotificationMessage!
		return html`
			<div class="px-4">
				${Alert({
					variant: notification.variant,
					children: html`
						<div class="flex flex-col gap-1">
							<div>${notification.message}</div>
							<div class="text-xs opacity-70">${new Date(notification.timestamp).toLocaleTimeString()}</div>
						</div>
					`,
				})}
			</div>
		`;
	},
};

// A user-side bubble (mirrors pi-web-ui's user-message markup) holding an
// undulating-ellipsis typing indicator — shown while the mic is recording.
const voicePendingRenderer: MessageRenderer<VoicePendingMessage> = {
	render: () => html`
		<div class="flex justify-start mx-4">
			<div class="user-message-container py-2 px-4 rounded-xl">
				<span class="cw-typing" aria-label="recording">
					<span></span><span></span><span></span>
				</span>
			</div>
		</div>
	`,
};

// ============================================================================
// 3. REGISTER RENDERER
// ============================================================================

export function registerCustomMessageRenderers() {
	registerMessageRenderer("system-notification", systemNotificationRenderer);
	registerMessageRenderer("voice-pending", voicePendingRenderer);
}

// ============================================================================
// 4. HELPER TO CREATE CUSTOM MESSAGES
// ============================================================================

export function createSystemNotification(
	message: string,
	variant: "default" | "destructive" = "default",
): SystemNotificationMessage {
	return {
		role: "system-notification",
		message,
		variant,
		timestamp: new Date().toISOString(),
	};
}

// ============================================================================
// 5. CUSTOM MESSAGE TRANSFORMER
// ============================================================================

/**
 * Custom message transformer that extends defaultConvertToLlm.
 * Handles system-notification messages by converting them to user messages.
 */
export function customConvertToLlm(messages: AgentMessage[]): Message[] {
	// First, handle our custom message types
	const processed = messages.map((m): AgentMessage => {
		if (m.role === "system-notification") {
			const notification = m as SystemNotificationMessage;
			// Convert to user message with <system> tags
			return {
				role: "user",
				content: `<system>${notification.message}</system>`,
				timestamp: Date.now(),
			};
		}
		if (m.role === "kg-context") {
			// The block is already a self-delimiting <kg-context>…</kg-context>
			// string; surface it as a user message so the model reads it as
			// retrieved context (mirrors CC's additionalContext injection).
			const kg = m as KgContextMessage;
			return { role: "user", content: kg.block, timestamp: Date.now() };
		}
		if (m.role === "compactionSummary") {
			// History bounding: the compaction summary REPLACES the cut history.
			// defaultConvertToLlm drops this role, which would silently delete the
			// summarized turns — so wrap the summary in the canonical prefix/suffix
			// and surface it as a user message the model actually reads.
			const cs = m as CompactionSummaryMessage;
			return {
				role: "user",
				content: `${COMPACTION_SUMMARY_PREFIX}${cs.summary}${COMPACTION_SUMMARY_SUFFIX}`,
				timestamp: Date.now(),
			};
		}
		return m;
	});

	// Then use defaultConvertToLlm for standard handling
	return defaultConvertToLlm(processed);
}
