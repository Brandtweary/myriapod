/**
 * Pure attachment types, shared by the chat message model and its renderers.
 * Kept free of any heavy document-parsing libraries so importing the type never
 * pulls the (unused) upload/extraction machinery into the bundle.
 */
export interface Attachment {
	id: string;
	type: "image" | "document";
	fileName: string;
	mimeType: string;
	size: number;
	content: string; // base64 encoded original data (without data URL prefix)
	extractedText?: string; // For documents: <pdf filename="..."><page number="1">text</page></pdf>
	preview?: string; // base64 image preview (first page for PDFs, or same as content for images)
}
