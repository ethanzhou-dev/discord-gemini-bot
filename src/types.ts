export interface DiscordUser {
	id?: string;
	username?: string;
	global_name?: string;
}

export interface DiscordAttachment {
	url: string;
	content_type?: string;
}

export interface DiscordMessage {
	content?: string;
	author?: DiscordUser;
	message_snapshots?: { message: DiscordMessage }[];
	attachments?: DiscordAttachment[];
}

export interface GeminiPart {
	text?: string;
	inlineData?: {
		mimeType: string;
		data: string;
	};
	thought?: boolean;
}

export interface GeminiHistoryItem {
	role: string;
	parts: GeminiPart[];
}

export interface OpenRouterContent {
	type: string;
	text?: string;
	image_url?: { url: string };
}

export interface OpenRouterMessage {
	role: string;
	content: string | OpenRouterContent[];
}

export interface Env {
	DISCORD_PUBLIC_KEY: string;
	DISCORD_APPLICATION_ID: string;
	GEMINI_API_KEY: string;
	SYSTEM_PROMPT?: string;
	GEMINI_MODEL?: string;
	OPENROUTER_API_KEY?: string;
	OPENROUTER_MODEL?: string;
	API_PROVIDER?: string;
	MEMORY_KV: KVNamespace;
}
