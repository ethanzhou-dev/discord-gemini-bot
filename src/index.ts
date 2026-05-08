import { verifyKey } from 'discord-interactions';

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

      if (commandName === 'ask' || commandName === 'Ask Bot') {
        let prompt = "";
        
        if (commandName === 'ask') {
          const options = interaction.data.options;
          prompt = options?.[0]?.value || options?.find((opt: any) => opt.name === '问题')?.value;
        } else if (commandName === 'Ask Bot') {
          const targetId = interaction.data.target_id;
          const messages = interaction.data.resolved?.messages;
          if (messages && messages[targetId]) {
            const targetMsg = messages[targetId];
            const targetAuthor = targetMsg.author?.global_name || targetMsg.author?.username || 'Unknown User';
            
            if (userObj?.id && targetMsg.author?.id === userObj.id) {
              prompt = targetMsg.content;
            } else {
              prompt = `(引用了 ${targetAuthor} 的消息: "${targetMsg.content}")`;
            }
          }
        }

        const response = Response.json({
          type: 5,
        });

        let finalPrompt = "";
        if (prompt) {
          finalPrompt = `[用户 ${userName}]: ${prompt}`;
          ctx.waitUntil(handleAskCommand(finalPrompt, interaction.token, env, channelId));
        } else {
          ctx.waitUntil(handleAskCommand(`[用户 ${userName}]: 无法读取消息内容或内容为空。`, interaction.token, env, channelId));
        }
        
        return response;
      }
    }

    return new Response('Not found', { status: 404 });
  }
};

async function handleAskCommand(prompt: string, token: string, env: Env, channelId: string) {
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

    history.push({
        role: "user",
        parts: [{ text: safePrompt }]
    });

    const requestBody: any = {
      contents: history
    };
    
    if (env.SYSTEM_PROMPT) {
      requestBody.system_instruction = {
        parts: [{ text: env.SYSTEM_PROMPT }]
      };
    }

    let geminiRes: Response | undefined;
    let geminiData: any;
    let retries = 0;
    const maxRetries = 3;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);

    try {
      while (true) {
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

        if (geminiRes.ok || geminiRes.status < 500 || retries >= maxRetries) {
          break;
        }

        retries++;
        console.warn(`Gemini API returned error status ${geminiRes.status}, retrying ${retries}/${maxRetries}...`);
        await new Promise(resolve => setTimeout(resolve, 1000 * retries));
      }
    } finally {
      clearTimeout(timeoutId);
    }

    let replyText = "";
    
    if (!geminiRes || !geminiRes.ok) {
       console.error('Gemini API Error:', JSON.stringify(geminiData, null, 2));
       const errorMsg = geminiData?.error?.message || JSON.stringify(geminiData);
       replyText = `抱歉，AI 服务返回了错误。\n状态码: ${geminiRes?.status || 'Unknown'}\n信息: ${errorMsg}`;
    } else {
       const parts = geminiData?.candidates?.[0]?.content?.parts;
       if (Array.isArray(parts)) {
          replyText = parts
            .filter((part: any) => !part.thought)
            .map((part: any) => part.text || "")
            .join("")
            .trim();
       }
       
       if (!replyText) {
          const finishReason = geminiData?.candidates?.[0]?.finishReason;
          if (finishReason && finishReason !== 'STOP') {
             replyText = `抱歉，内容生成被拦截。原因: ${finishReason}`;
          } else {
             console.error('Gemini API Unexpected Response:', JSON.stringify(geminiData, null, 2));
             replyText = `抱歉，收到意外的 API 响应格式。\n响应内容: ${JSON.stringify(geminiData).substring(0, 500)}`;
          }
       }
    }

    if (replyText && env.MEMORY_KV) {
        const MAX_HISTORY_LENGTH = 60;
        history.push({
            role: "model",
            parts: [{ text: replyText }]
        });
        
        if (history.length > MAX_HISTORY_LENGTH) {
            history = history.slice(history.length - MAX_HISTORY_LENGTH);
        }
        
        await env.MEMORY_KV.put(historyKey, JSON.stringify(history)).catch(console.error);
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
    if (e.name === 'AbortError') {
       errorMessage = "请求超时 (AI 服务响应时间超过25秒)";
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