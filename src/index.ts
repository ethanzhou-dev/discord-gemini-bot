import { verifyKey } from 'discord-interactions';
import { Buffer } from 'node:buffer';

export interface Env {
  DISCORD_PUBLIC_KEY: string;
  DISCORD_APPLICATION_ID: string;
  GEMINI_API_KEY: string;
  SYSTEM_PROMPT?: string;
  GEMINI_MODEL?: string;
  MEMORY_KV: any;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const signature = request.headers.get('x-signature-ed25519');
    const timestamp = request.headers.get('x-signature-timestamp');
    const body = await request.text();

    if (!signature || !timestamp || !env.DISCORD_PUBLIC_KEY) {
      return new Response('Missing headers or configuration', { status: 401 });
    }

    const isValidRequest = await verifyKey(
      body,
      signature,
      timestamp,
      env.DISCORD_PUBLIC_KEY
    );

    if (!isValidRequest) {
      return new Response('Bad request signature', { status: 401 });
    }

    const interaction = JSON.parse(body);

    if (interaction.type === 1) {
      return Response.json({ type: 1 });
    }

    if (interaction.type === 2) {
      const commandName = interaction.data.name;
      const channelId = interaction.channel_id || interaction.channel?.id || 'global';
      const userObj = interaction.member?.user || interaction.user;
      const userName = interaction.member?.nick || userObj?.global_name || userObj?.username || 'Unknown';

      if (commandName === 'Quote & Ask') {
        const targetId = interaction.data.target_id;
        const messages = interaction.data.resolved?.messages;
        let quotedText = "";
        let quotedImages: string[] = [];
        
        if (messages && messages[targetId]) {
          const targetMsg = messages[targetId];
          const targetAuthor = targetMsg.author?.global_name || targetMsg.author?.username || 'Unknown User';
          
          let content = targetMsg.content;
          if (!content && targetMsg.message_snapshots && targetMsg.message_snapshots.length > 0) {
            const snapshotMessage = targetMsg.message_snapshots[0].message;
            if (snapshotMessage && snapshotMessage.content) {
              content = snapshotMessage.content;
            }
          }
          
          if (userObj?.id && targetMsg.author?.id === userObj.id) {
            quotedText = content;
          } else {
            quotedText = `(引用了 ${targetAuthor} 的消息: "${content}")`;
          }
          if (quotedText.length > 4000) {
            quotedText = quotedText.substring(0, 3995) + '...';
          }

          if (targetMsg.attachments && targetMsg.attachments.length > 0) {
             targetMsg.attachments.forEach((att: any) => {
                if (att.content_type?.startsWith('image/')) {
                   quotedImages.push(att.url);
                }
             });
          }
        }
        
        const quoteKey = `quote_${interaction.id}`;
        if (env.MEMORY_KV) {
          const quoteData = JSON.stringify({ text: quotedText, images: quotedImages });
          ctx.waitUntil(env.MEMORY_KV.put(quoteKey, quoteData, { expirationTtl: 300 }).catch(console.error));
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
                    required: true
                  }
                ]
              }
            ]
          }
        });
      }

      if (commandName === 'ask' || commandName === 'Ask Bot') {
        let prompt = "";
        let imageUrls: string[] = [];
        
        if (commandName === 'ask') {
          const options = interaction.data.options;
          prompt = options?.[0]?.value || options?.find((opt: any) => opt.name === '问题')?.value;
          const attachmentId = options?.find((opt: any) => opt.name === '图片')?.value;
          if (attachmentId && interaction.data.resolved?.attachments?.[attachmentId]) {
             imageUrls.push(interaction.data.resolved.attachments[attachmentId].url);
          }
        } else if (commandName === 'Ask Bot') {
          const targetId = interaction.data.target_id;
          const messages = interaction.data.resolved?.messages;
          if (messages && messages[targetId]) {
            const targetMsg = messages[targetId];
            const targetAuthor = targetMsg.author?.global_name || targetMsg.author?.username || 'Unknown User';
            
            let content = targetMsg.content;
            if (!content && targetMsg.message_snapshots && targetMsg.message_snapshots.length > 0) {
              const snapshotMessage = targetMsg.message_snapshots[0].message;
              if (snapshotMessage && snapshotMessage.content) {
                content = snapshotMessage.content;
              }
            }
            
            if (userObj?.id && targetMsg.author?.id === userObj.id) {
              prompt = content;
            } else {
              prompt = `(引用了 ${targetAuthor} 的消息: "${content}")`;
            }

            if (targetMsg.attachments && targetMsg.attachments.length > 0) {
               targetMsg.attachments.forEach((att: any) => {
                  if (att.content_type?.startsWith('image/')) {
                     imageUrls.push(att.url);
                  }
               });
            }
          }
        }

        const response = Response.json({
          type: 5,
        });

        let finalPrompt = "";
        if (prompt || imageUrls.length > 0) {
          finalPrompt = `[用户 ${userName}]: ${prompt || (imageUrls.length > 0 ? "[图片]" : "")}`;
          let displayMessage = undefined;
          if (prompt && commandName === 'ask') {
            displayMessage = `> **提问:** ${prompt}`;
          }
          ctx.waitUntil(handleAskCommand(finalPrompt, interaction.token, env, channelId, displayMessage, imageUrls));
        } else {
          ctx.waitUntil(handleAskCommand(`[用户 ${userName}]: 无法读取消息内容或内容为空。`, interaction.token, env, channelId));
        }
        
        return response;
      }
    }

    if (interaction.type === 5) {
      const customId = interaction.data?.custom_id;
      if (customId && customId.startsWith('quote_ask_modal:')) {
        const quoteKey = customId.split(':')[1];
        
        const channelId = interaction.channel_id || interaction.channel?.id || 'global';
        const userObj = interaction.member?.user || interaction.user;
        const userName = interaction.member?.nick || userObj?.global_name || userObj?.username || 'Unknown';
        
        const response = Response.json({
          type: 5,
        });
        
        ctx.waitUntil((async () => {
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
                  } catch (e) {
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
                  if (comp.custom_id === 'question') {
                    question = comp.value;
                  }
                }
              }
            }

            let finalPrompt = `[用户 ${userName}]: ${question}\n\n${quotedText}`;
            let displayMessage = `> **提问:** ${question}`;
            await handleAskCommand(finalPrompt, interaction.token, env, channelId, displayMessage, imageUrls);
          } catch (e) {
            console.error("Error in modal submit processing:", e);
            const discordUrl = `https://discord.com/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/${interaction.token}/messages/@original`;
            await fetch(discordUrl, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                content: "处理引用时发生内部错误。"
              })
            }).catch(console.error);
          }
        })());
        
        return response;
      }
    }

    return new Response('Not found', { status: 404 });
  }
};

async function handleAskCommand(prompt: string, token: string, env: Env, channelId: string, displayMessage?: string, imageUrls?: string[]) {
  const startTime = Date.now();
  const MAX_WORKER_TIME = 28000;
  try {
    const model = env.GEMINI_MODEL || 'gemini-3.1-flash';
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
    
    const safePrompt = (prompt && prompt.trim() !== '') ? prompt : "你好";

    let history: any[] = [];
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

    const userParts: any[] = [{ text: safePrompt }];
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
        parts: userParts
    });

    let sanitizedHistory: any[] = [];
    let expectedRole = 'user';
    for (let i = history.length - 1; i >= 0; i--) {
        const h = history[i];
        if (h && h.role === expectedRole && h.parts && h.parts.length > 0 && (h.parts.some((p: any) => p.text?.trim() !== '') || h.parts.some((p: any) => p.inlineData))) {
            sanitizedHistory.unshift(h);
            expectedRole = expectedRole === 'user' ? 'model' : 'user';
        }
    }
    
    if (sanitizedHistory.length > 0 && sanitizedHistory[0].role !== 'user') {
        sanitizedHistory.shift();
    }
    history = sanitizedHistory;

    const MAX_HISTORY_LENGTH = 16;
    if (history.length > MAX_HISTORY_LENGTH) {
        history = history.slice(history.length - MAX_HISTORY_LENGTH);
        if (history.length > 0 && history[0].role !== 'user') {
            history.shift();
        }
    }

    const requestBody: any = {
      contents: history,
      generationConfig: {
        maxOutputTokens: 1500,
      }
    };
    
    if (env.SYSTEM_PROMPT) {
      requestBody.systemInstruction = {
        parts: [{ text: env.SYSTEM_PROMPT }]
      };
    }

    let geminiRes: Response | undefined;
    let geminiData: any;
    let retries = 0;
    const maxRetries = 2;

    while (retries <= maxRetries) {
      const timeElapsed = Date.now() - startTime;
      const timeRemaining = MAX_WORKER_TIME - timeElapsed;
      if (timeRemaining <= 3000) {
         throw new Error('Worker execution time limit exceeded');
      }

      const controller = new AbortController();
      const timeoutMs = timeRemaining - 3000;
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        geminiRes = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
          signal: controller.signal
        });

        try {
          geminiData = await geminiRes.json();
        } catch (err) {
          geminiData = { error: { message: `Invalid JSON response: ${geminiRes.statusText}` } };
        }
      } catch (fetchErr: any) {
        clearTimeout(timeoutId);
        const elapsedNow = Date.now() - startTime;
        if (fetchErr.name === 'AbortError' && retries < maxRetries && elapsedNow < MAX_WORKER_TIME - 5000) {
          retries++;
          console.warn(`Gemini API request timed out, retrying ${retries}/${maxRetries}...`);
          continue;
        }
        throw fetchErr;
      } finally {
        clearTimeout(timeoutId);
      }

      if (geminiRes.ok || (geminiRes.status < 500)) {
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
      console.warn(`Gemini API returned error status ${geminiRes.status}, retrying ${retries}/${maxRetries}...`);
      
      if (retries === maxRetries && geminiRes.status >= 500) {
          console.warn("Dropping conversation history for final retry to bypass potential payload-induced 500 error.");
          requestBody.contents = [{ role: "user", parts: [{ text: safePrompt }] }];
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    let replyText = "";
    let isError = false;
    
    if (!geminiRes || !geminiRes.ok) {
       isError = true;
       console.error('Gemini API Error:', JSON.stringify(geminiData, null, 2));
       const errorMsg = geminiData?.error?.message || JSON.stringify(geminiData);
       if (geminiRes?.status === 429) {
          replyText = `抱歉，服务当前请求过多被限流，请稍候重试。\n信息: ${errorMsg}`;
       } else {
          replyText = `抱歉，AI 服务返回了错误。\n状态码: ${geminiRes?.status || 'Unknown'}\n信息: ${errorMsg}`;
       }
    } else {
       const parts = geminiData?.candidates?.[0]?.content?.parts;
       if (Array.isArray(parts)) {
          replyText = parts
            .filter((part: any) => !part.thought)
            .map((part: any) => part.text || "")
            .join("")
            .trim();
            
          replyText = replyText.replace(/<think>[\s\S]*?<\/think>\n*/gi, '').trim();

          replyText = replyText.replace(/\$\\rightarrow\$/g, '->')
                               .replace(/\\rightarrow/g, '->')
                               .replace(/\$\\Rightarrow\$/g, '=>')
                               .replace(/\\Rightarrow/g, '=>');
       }
       
       if (!replyText) {
          isError = true;
          const finishReason = geminiData?.candidates?.[0]?.finishReason;
          if (finishReason && finishReason !== 'STOP') {
             replyText = `抱歉，内容生成被拦截。原因: ${finishReason}`;
          } else {
             console.error('Gemini API Unexpected Response:', JSON.stringify(geminiData, null, 2));
             replyText = `抱歉，收到意外的 API 响应格式。\n响应内容: ${JSON.stringify(geminiData).substring(0, 500)}`;
          }
       }
    }

    if (replyText && env.MEMORY_KV && !isError) {
        history.push({
            role: "model",
            parts: [{ text: replyText }]
        });
        
        if (history.length > MAX_HISTORY_LENGTH) {
            history = history.slice(history.length - MAX_HISTORY_LENGTH);
        }
        
        const historyToSave = history.map(h => ({
            ...h,
            parts: h.parts.filter((p: any) => !p.inlineData)
        }));
        
        env.MEMORY_KV.put(historyKey, JSON.stringify(historyToSave)).catch(console.error);
    }

    if (displayMessage) {
        replyText = `${displayMessage}\n\n${replyText}`;
    }

    const maxLength = 2000;
    const chunks: string[] = [];
    let remainingText = replyText;
    
    while (remainingText.length > 0) {
      if (remainingText.length <= maxLength) {
        chunks.push(remainingText);
        break;
      }
      
      let breakIndex = remainingText.lastIndexOf('\n', maxLength);
      if (breakIndex === -1 || breakIndex < maxLength * 0.5) {
         breakIndex = maxLength;
      }
      
      chunks.push(remainingText.substring(0, breakIndex));
      remainingText = remainingText.substring(breakIndex).replace(/^\n+/, '');
    }

    const discordUrl = `https://discord.com/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/${token}/messages/@original`;
    const patchRes = await fetch(discordUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: chunks[0] || "No content generated."
      })
    });
    
    if (!patchRes.ok) {
        console.error('Failed to update Discord message:', patchRes.status, await patchRes.text());
    }

    for (let i = 1; i < chunks.length; i++) {
      const followUpUrl = `https://discord.com/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/${token}`;
      const postRes = await fetch(followUpUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: chunks[i]
        })
      });
      if (!postRes.ok) {
        console.error(`Failed to send follow-up message ${i}:`, postRes.status, await postRes.text());
      }
    }
  } catch (e: any) {
    console.error(e);
    let errorMessage = "请求 AI 服务时发生网络错误。";
    if (e.name === 'AbortError' || e.message === 'Worker execution time limit exceeded') {
       errorMessage = "请求超时，正在重试... 请稍后再试。";
    }
    const discordUrl = `https://discord.com/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/${token}/messages/@original`;
    const patchRes = await fetch(discordUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: errorMessage
      })
    });
    if (!patchRes.ok) {
        console.error('Failed to send error message to Discord:', patchRes.status, await patchRes.text());
    }
  }
}

async function fetchImageAsBase64(url: string): Promise<{ mimeType: string, data: string } | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const arrayBuffer = await response.arrayBuffer();
    
    const base64 = Buffer.from(arrayBuffer).toString('base64');
    
    const mimeType = response.headers.get('content-type') || 'image/jpeg';
    return { mimeType, data: base64 };
  } catch (e) {
    console.error("Failed to fetch image:", e);
    return null;
  }
}