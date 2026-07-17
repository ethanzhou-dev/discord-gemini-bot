import { Buffer } from "node:buffer";
import { verifyKey } from "discord-interactions";
import type {
	DiscordAttachment,
	DiscordMessage,
	DiscordUser,
	Env,
	GeminiHistoryItem,
	GeminiPart,
	OpenRouterContent,
	OpenRouterMessage,
} from "./types";

function discordWebhookUrl(
	appId: string,
	token: string,
	suffix = "/messages/@original",
) {
	return `https://discord.com/api/v10/webhooks/${appId}/${token}${suffix}`;
}

function extractMessageContent(
	targetMsg: DiscordMessage,
	userObj: DiscordUser,
): { text: string; images: string[] } {
	const targetAuthor =
		targetMsg.author?.global_name ||
		targetMsg.author?.username ||
		"Unknown User";

	let content = targetMsg.content || "";
	if (
		!content &&
		targetMsg.message_snapshots &&
		targetMsg.message_snapshots.length > 0
	) {
		const snapshotMessage = targetMsg.message_snapshots[0].message;
		if (snapshotMessage?.content) {
			content = snapshotMessage.content;
		}
	}

	let text: string;
	if (userObj?.id && targetMsg.author?.id === userObj.id) {
		text = content;
	} else {
		text = `(引用了 ${targetAuthor} 的消息: "${content}")`;
	}

	const images: string[] = [];
	if (targetMsg.attachments && targetMsg.attachments.length > 0) {
		targetMsg.attachments.forEach((att: DiscordAttachment) => {
			if (att.content_type?.startsWith("image/")) {
				images.push(att.url);
			}
		});
	}

	return { text, images };
}

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		if (request.method !== "POST") {
			return new Response("Method Not Allowed", { status: 405 });
		}

		const signature = request.headers.get("x-signature-ed25519");
		const timestamp = request.headers.get("x-signature-timestamp");
		const body = await request.text();

		if (!signature || !timestamp || !env.DISCORD_PUBLIC_KEY) {
			return new Response("Missing headers or configuration", { status: 401 });
		}

		const isValidRequest = await verifyKey(
			body,
			signature,
			timestamp,
			env.DISCORD_PUBLIC_KEY,
		);

		if (!isValidRequest) {
			return new Response("Bad request signature", { status: 401 });
		}

		const interaction = JSON.parse(body);

		if (interaction.type === 1) {
			return Response.json({ type: 1 });
		}

		if (interaction.type === 2) {
			const commandName = interaction.data.name;
			const channelId =
				interaction.channel_id || interaction.channel?.id || "global";
			const userObj = interaction.member?.user || interaction.user;
			const userName =
				interaction.member?.nick ||
				userObj?.global_name ||
				userObj?.username ||
				"Unknown";

			if (commandName === "Quote & Ask") {
				const targetId = interaction.data.target_id;
				const messages = interaction.data.resolved?.messages;
				let quotedText = "";
				let quotedImages: string[] = [];

				if (messages?.[targetId]) {
					const extracted = extractMessageContent(messages[targetId], userObj);
					quotedText = extracted.text;
					quotedImages = extracted.images;

					if (quotedText.length > 4000) {
						quotedText = `${quotedText.substring(0, 3995)}...`;
					}
				}

				const quoteKey = `quote_${interaction.id}`;
				if (env.MEMORY_KV) {
					const quoteData = JSON.stringify({
						text: quotedText,
						images: quotedImages,
					});
					ctx.waitUntil(
						env.MEMORY_KV.put(quoteKey, quoteData, {
							expirationTtl: 300,
						}).catch(console.error),
					);
				}

				return Response.json({
					type: 9,
					data: {
						title: "引用并提问",
						custom_id: `quote_ask_modal:${quoteKey}`,
						components: [
							{
								type: 1,
								components: [
									{
										type: 4,
										custom_id: "question",
										label: "你的问题",
										style: 2,
										min_length: 1,
										max_length: 1000,
										required: true,
									},
								],
							},
						],
					},
				});
			}

			if (commandName === "ask" || commandName === "Ask Bot") {
				let prompt = "";
				let imageUrls: string[] = [];

				if (commandName === "ask") {
					const options = interaction.data.options;
					prompt =
						options?.find(
							(opt: { name: string; value: string }) => opt.name === "问题",
						)?.value || "";
					const attachmentId = options?.find(
						(opt: { name: string; value: string }) => opt.name === "图片",
					)?.value;
					if (
						attachmentId &&
						interaction.data.resolved?.attachments?.[attachmentId]
					) {
						imageUrls.push(
							interaction.data.resolved.attachments[attachmentId].url,
						);
					}
				} else if (commandName === "Ask Bot") {
					const targetId = interaction.data.target_id;
					const messages = interaction.data.resolved?.messages;
					if (messages?.[targetId]) {
						const extracted = extractMessageContent(
							messages[targetId],
							userObj,
						);
						prompt = extracted.text;
						imageUrls = extracted.images;
					}
				}

				const response = Response.json({
					type: 5,
				});

				let finalPrompt = "";
				if (prompt || imageUrls.length > 0) {
					finalPrompt = `[用户 ${userName}]: ${prompt || (imageUrls.length > 0 ? "[图片]" : "")}`;
					let displayMessage: string | undefined;
					if (commandName === "ask") {
						const parts: string[] = [];
						if (prompt) {
							parts.push(`> **提问:** ${prompt}`);
						}
						if (imageUrls.length > 0) {
							parts.push(imageUrls.map((url) => url).join("\n"));
						}
						if (parts.length > 0) {
							displayMessage = parts.join("\n");
						}
					}
					ctx.waitUntil(
						handleAskCommand(
							finalPrompt,
							interaction.token,
							env,
							channelId,
							displayMessage,
							imageUrls,
						),
					);
				} else {
					ctx.waitUntil(
						handleAskCommand(
							`[用户 ${userName}]: 无法读取消息内容或内容为空。`,
							interaction.token,
							env,
							channelId,
						),
					);
				}

				return response;
			}
		}

		if (interaction.type === 5) {
			const customId = interaction.data?.custom_id;
			if (customId?.startsWith("quote_ask_modal:")) {
				const quoteKey = customId.substring("quote_ask_modal:".length);

				const channelId =
					interaction.channel_id || interaction.channel?.id || "global";
				const userObj = interaction.member?.user || interaction.user;
				const userName =
					interaction.member?.nick ||
					userObj?.global_name ||
					userObj?.username ||
					"Unknown";

				const response = Response.json({
					type: 5,
				});

				ctx.waitUntil(
					(async () => {
						try {
							let quotedText = "";
							let imageUrls: string[] = [];
							if (env.MEMORY_KV) {
								const rawQuote = await env.MEMORY_KV.get(quoteKey);
								if (rawQuote) {
									try {
										const parsed = JSON.parse(rawQuote);
										quotedText = parsed.text;
										imageUrls = parsed.images || [];
									} catch (_e) {
										quotedText = rawQuote;
									}
								} else {
									quotedText = "(无法获取引用的消息，可能已过期)";
								}
							} else {
								quotedText = "(KV 存储未配置，无法获取引用的消息)";
							}

							const components = interaction.data.components;
							let question = "";

							for (const row of components) {
								if (row.components) {
									for (const comp of row.components) {
										if (comp.custom_id === "question") {
											question = comp.value;
										}
									}
								}
							}

							const finalPrompt = `[用户 ${userName}]: ${question}\n\n${quotedText}`;
							const displayMessage = `> **提问:** ${question}`;
							await handleAskCommand(
								finalPrompt,
								interaction.token,
								env,
								channelId,
								displayMessage,
								imageUrls,
							);
						} catch (e) {
							console.error("Error in modal submit processing:", e);
							const errorUrl = discordWebhookUrl(
								env.DISCORD_APPLICATION_ID,
								interaction.token,
							);
							await fetch(errorUrl, {
								method: "PATCH",
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify({
									content: "处理引用时发生内部错误。",
								}),
							}).catch(console.error);
						}
					})(),
				);

				return response;
			}
		}

		return new Response("Not found", { status: 404 });
	},
};

async function handleAskCommand(
	prompt: string,
	token: string,
	env: Env,
	channelId: string,
	displayMessage?: string,
	imageUrls?: string[],
) {
	const startTime = Date.now();
	const MAX_WORKER_TIME = 28000;
	try {
		const safePrompt = prompt && prompt.trim() !== "" ? prompt : "你好";

		let history: GeminiHistoryItem[] = [];
		const historyKey = `history_${channelId}`;
		if (env.MEMORY_KV) {
			const historyStr = await env.MEMORY_KV.get(historyKey);
			if (historyStr) {
				try {
					history = JSON.parse(historyStr);
				} catch (e) {
					console.error("Failed to parse history from KV", e);
				}
			}
		}

		const userParts: GeminiPart[] = [{ text: safePrompt }];
		if (imageUrls && imageUrls.length > 0) {
			for (const url of imageUrls) {
				const imageData = await fetchImageAsBase64(url);
				if (imageData) {
					userParts.push({ inlineData: imageData });
				}
			}
		}

		history.push({
			role: "user",
			parts: userParts,
		});

		const sanitizedHistory: GeminiHistoryItem[] = [];
		let expectedRole = "user";
		for (let i = history.length - 1; i >= 0; i--) {
			const h = history[i];
			if (
				h &&
				h.role === expectedRole &&
				h.parts &&
				h.parts.length > 0 &&
				(h.parts.some((p: GeminiPart) => p.text?.trim() !== "") ||
					h.parts.some((p: GeminiPart) => p.inlineData))
			) {
				sanitizedHistory.unshift(h);
				expectedRole = expectedRole === "user" ? "model" : "user";
			}
		}

		if (sanitizedHistory.length > 0 && sanitizedHistory[0].role !== "user") {
			sanitizedHistory.shift();
		}
		history = sanitizedHistory;

		const MAX_HISTORY_LENGTH = 16;
		if (history.length > MAX_HISTORY_LENGTH) {
			history = history.slice(history.length - MAX_HISTORY_LENGTH);
			if (history.length > 0 && history[0].role !== "user") {
				history.shift();
			}
		}

		const provider = env.API_PROVIDER?.toUpperCase() || "OPENROUTER";
		const isOpenRouter = provider === "OPENROUTER";

		let apiUrl = "";
		const apiHeaders: Record<string, string> = {
			"Content-Type": "application/json",
		};
		let apiBody: Record<string, unknown> = {};

		if (isOpenRouter) {
			apiUrl = "https://openrouter.ai/api/v1/chat/completions";
			apiHeaders.Authorization = `Bearer ${env.OPENROUTER_API_KEY}`;

			const orModel = env.OPENROUTER_MODEL || "";
			const orMessages: OpenRouterMessage[] = [];
			if (env.SYSTEM_PROMPT) {
				orMessages.push({ role: "system", content: env.SYSTEM_PROMPT });
			}
			for (const h of history) {
				const role = h.role === "model" ? "assistant" : h.role;
				const content: OpenRouterContent[] = [];
				for (const p of h.parts) {
					if (p.text) content.push({ type: "text", text: p.text });
					if (p.inlineData)
						content.push({
							type: "image_url",
							image_url: {
								url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}`,
							},
						});
				}
				orMessages.push({ role, content });
			}
			apiBody = {
				model: orModel,
				messages: orMessages,
				max_tokens: 1500,
			};
		} else {
			const model = env.GEMINI_MODEL || "gemini-3.1-flash";
			apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
			apiBody = {
				contents: history,
				generationConfig: {
					maxOutputTokens: 1500,
				},
			};
			if (env.SYSTEM_PROMPT) {
				apiBody.systemInstruction = {
					parts: [{ text: env.SYSTEM_PROMPT }],
				};
			}
		}

		let apiRes: Response | undefined;
		let apiData:
			| {
					choices?: { message?: { content?: string } }[];
					candidates?: {
						content?: { parts?: { text?: string }[] };
						finishReason?: string;
					}[];
					error?: { message?: string };
			  }
			| undefined;
		let retries = 0;
		const maxRetries = 2;

		while (retries <= maxRetries) {
			const timeElapsed = Date.now() - startTime;
			const timeRemaining = MAX_WORKER_TIME - timeElapsed;
			if (timeRemaining <= 3000) {
				throw new Error("Worker execution time limit exceeded");
			}

			const controller = new AbortController();
			const timeoutMs = timeRemaining - 3000;
			const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

			try {
				apiRes = await fetch(apiUrl, {
					method: "POST",
					headers: apiHeaders,
					body: JSON.stringify(apiBody),
					signal: controller.signal,
				});

				try {
					apiData = await apiRes.json();
				} catch (_err) {
					apiData = {
						error: { message: `Invalid JSON response: ${apiRes.statusText}` },
					};
				}
			} catch (fetchErr: unknown) {
				const elapsedNow = Date.now() - startTime;
				if (
					fetchErr instanceof Error &&
					fetchErr.name === "AbortError" &&
					retries < maxRetries &&
					elapsedNow < MAX_WORKER_TIME - 5000
				) {
					retries++;
					console.warn(
						`API request timed out, retrying ${retries}/${maxRetries}...`,
					);
					continue;
				}
				throw fetchErr;
			} finally {
				clearTimeout(timeoutId);
			}

			if (apiRes.ok || apiRes.status < 500) {
				break;
			}

			if (retries >= maxRetries) {
				break;
			}

			const elapsedNow = Date.now() - startTime;
			if (elapsedNow > MAX_WORKER_TIME - 5000) {
				break;
			}

			retries++;
			console.warn(
				`API returned error status ${apiRes.status}, retrying ${retries}/${maxRetries}...`,
			);

			if (retries === maxRetries && apiRes.status >= 500) {
				console.warn(
					"Dropping conversation history for final retry to bypass potential payload-induced 500 error.",
				);
				if (isOpenRouter) {
					const safeOrMessages: OpenRouterMessage[] = [];
					if (env.SYSTEM_PROMPT) {
						safeOrMessages.push({ role: "system", content: env.SYSTEM_PROMPT });
					}
					safeOrMessages.push({
						role: "user",
						content: [{ type: "text", text: safePrompt }],
					});
					apiBody.messages = safeOrMessages;
				} else {
					apiBody.contents = [{ role: "user", parts: [{ text: safePrompt }] }];
				}
			}

			await new Promise((resolve) => setTimeout(resolve, 1000));
		}

		let replyText = "";
		let isError = false;

		if (!apiRes?.ok) {
			isError = true;
			console.error("API Error:", JSON.stringify(apiData, null, 2));
			if (apiRes?.status === 429) {
				replyText = "抱歉，服务当前请求过多被限流，请稍候重试。";
			} else {
				replyText = `抱歉，AI 服务返回了错误 (${apiRes?.status || "Unknown"})，请稍后重试。`;
			}
		} else {
			if (isOpenRouter) {
				replyText = apiData?.choices?.[0]?.message?.content || "";
				if (!replyText) {
					isError = true;
					console.error(
						"OpenRouter API Unexpected Response:",
						JSON.stringify(apiData, null, 2),
					);
					replyText = "抱歉，AI 返回了意外的响应格式，请稍后重试。";
				}
			} else {
				const parts = apiData?.candidates?.[0]?.content?.parts;
				if (Array.isArray(parts)) {
					replyText = parts
						.filter((part: GeminiPart) => !part.thought)
						.map((part: GeminiPart) => part.text || "")
						.join("")
						.trim();

					replyText = replyText
						.replace(/<think>[\s\S]*?<\/think>\n*/gi, "")
						.trim();

					replyText = replyText
						.replace(/\$\\rightarrow\$/g, "->")
						.replace(/\\rightarrow/g, "->")
						.replace(/\$\\Rightarrow\$/g, "=>")
						.replace(/\\Rightarrow/g, "=>");
				}

				if (!replyText) {
					isError = true;
					const finishReason = apiData?.candidates?.[0]?.finishReason;
					if (finishReason && finishReason !== "STOP") {
						replyText = `抱歉，内容生成被拦截。原因: ${finishReason}`;
					} else {
						console.error(
							"Gemini API Unexpected Response:",
							JSON.stringify(apiData, null, 2),
						);
						replyText = "抱歉，AI 返回了意外的响应格式，请稍后重试。";
					}
				}
			}
		}

		if (replyText && env.MEMORY_KV && !isError) {
			history.push({
				role: "model",
				parts: [{ text: replyText }],
			});

			if (history.length > MAX_HISTORY_LENGTH) {
				history = history.slice(history.length - MAX_HISTORY_LENGTH);
			}

			const historyToSave = history.map((h) => ({
				...h,
				parts: h.parts.filter((p: GeminiPart) => !p.inlineData),
			}));

			await env.MEMORY_KV.put(historyKey, JSON.stringify(historyToSave)).catch(
				console.error,
			);
		}

		if (displayMessage) {
			replyText = `${displayMessage}\n\n${replyText}`;
		}

		const chunks = splitMessageChunks(replyText, 2000);

		const patchUrl = discordWebhookUrl(env.DISCORD_APPLICATION_ID, token);
		const patchRes = await fetch(patchUrl, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content: chunks[0] || "No content generated.",
			}),
		});

		if (!patchRes.ok) {
			console.error(
				"Failed to update Discord message:",
				patchRes.status,
				await patchRes.text(),
			);
		}

		for (let i = 1; i < chunks.length; i++) {
			const followUpUrl = discordWebhookUrl(
				env.DISCORD_APPLICATION_ID,
				token,
				"",
			);
			const postRes = await fetch(followUpUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					content: chunks[i],
				}),
			});
			if (!postRes.ok) {
				console.error(
					`Failed to send follow-up message ${i}:`,
					postRes.status,
					await postRes.text(),
				);
			}
		}
	} catch (e: unknown) {
		console.error(e);
		let errorMessage = "请求 AI 服务时发生网络错误。";
		if (
			e instanceof Error &&
			(e.name === "AbortError" ||
				e.message === "Worker execution time limit exceeded")
		) {
			errorMessage = "请求超时，正在重试... 请稍后再试。";
		}
		const errorUrl = discordWebhookUrl(env.DISCORD_APPLICATION_ID, token);
		const patchRes = await fetch(errorUrl, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content: errorMessage,
			}),
		});
		if (!patchRes.ok) {
			console.error(
				"Failed to send error message to Discord:",
				patchRes.status,
				await patchRes.text(),
			);
		}
	}
}

function splitMessageChunks(text: string, maxLength: number): string[] {
	const chunks: string[] = [];
	let remaining = text;

	while (remaining.length > 0) {
		if (remaining.length <= maxLength) {
			chunks.push(remaining);
			break;
		}

		const breakIndex = findSafeBreakPoint(remaining, maxLength);

		chunks.push(remaining.substring(0, breakIndex));
		remaining = remaining.substring(breakIndex).replace(/^\n+/, "");
	}

	return chunks;
}

function findSafeBreakPoint(text: string, maxLength: number): number {
	const candidate = text.substring(0, maxLength);
	const fenceMatches = candidate.match(/^```/gm);
	const fenceCount = fenceMatches ? fenceMatches.length : 0;
	const insideCodeBlock = fenceCount % 2 !== 0;

	if (insideCodeBlock) {
		const lastFenceIndex = candidate.lastIndexOf("\n```");
		if (lastFenceIndex > maxLength * 0.3) {
			return lastFenceIndex;
		}
	}

	let breakIndex = candidate.lastIndexOf("\n");
	if (breakIndex === -1 || breakIndex < maxLength * 0.5) {
		breakIndex = maxLength;
	}

	return breakIndex;
}

const IMAGE_FETCH_TIMEOUT_MS = 5000;

async function fetchImageAsBase64(
	url: string,
): Promise<{ mimeType: string; data: string } | null> {
	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(
			() => controller.abort(),
			IMAGE_FETCH_TIMEOUT_MS,
		);

		const response = await fetch(url, { signal: controller.signal });
		clearTimeout(timeoutId);

		if (!response.ok) return null;

		const arrayBuffer = await response.arrayBuffer();

		const base64 = Buffer.from(arrayBuffer).toString("base64");

		const mimeType = response.headers.get("content-type") || "image/jpeg";
		return { mimeType, data: base64 };
	} catch (e) {
		console.error("Failed to fetch image:", e);
		return null;
	}
}
