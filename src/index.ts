import { verifyKey } from 'discord-interactions';

export interface Env {
  DISCORD_PUBLIC_KEY: string;
  DISCORD_APPLICATION_ID: string;
  GEMINI_API_KEY: string;
  // 可选配置：人设和模型
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

    // 1. Verify Discord request signature
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

    // 2. Handle PING from Discord
    if (interaction.type === 1) { // InteractionType.PING
      return Response.json({ type: 1 }); // InteractionResponseType.PONG
    }

    // 3. Handle Command Application
    if (interaction.type === 2) { // InteractionType.APPLICATION_COMMAND
      const commandName = interaction.data.name;
      const userId = interaction.member?.user?.id || interaction.user?.id;

      if (commandName === 'clear') {
        if (userId && env.MEMORY_KV) {
            ctx.waitUntil(env.MEMORY_KV.delete(`history_${userId}`));
        }
        return Response.json({
          type: 4, // CHANNEL_MESSAGE_WITH_SOURCE
          data: { content: '✅ 你的对话记忆已清除' }
        });
      }

      if (commandName === 'ask' || commandName === 'Ask Bot') {
        let prompt = "";
        
        if (commandName === 'ask') {
          const options = interaction.data.options;
          prompt = options?.[0]?.value || options?.find((opt: any) => opt.name === '问题')?.value;
        } else if (commandName === 'Ask Bot') {
          const targetId = interaction.data.target_id;
          const messages = interaction.data.resolved?.messages;
          if (messages && messages[targetId]) {
            prompt = messages[targetId].content;
          }
        }

        // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
        const response = Response.json({
          type: 5,
        });

        // Use ctx.waitUntil to process the Gemini request in the background
        if (prompt) {
          ctx.waitUntil(handleAskCommand(prompt, interaction.token, env, userId));
        } else {
          ctx.waitUntil(handleAskCommand("无法读取消息内容或内容为空。", interaction.token, env, userId)); // Default prompt if somehow empty
        }
        
        return response;
      }
    }

    return new Response('Not found', { status: 404 });
  }
};

async function handleAskCommand(prompt: string, token: string, env: Env, userId?: string) {
  try {
    // 1. Request Gemini API
    const model = env.GEMINI_MODEL || 'gemini-1.5-flash';
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
    
    // 确保 prompt 不为空
    const safePrompt = (prompt && prompt.trim() !== '') ? prompt : "你好";

    // 2. 读取历史记录
    let history: any[] = [];
    const historyKey = `history_${userId}`;
    if (userId && env.MEMORY_KV) {
        const historyStr = await env.MEMORY_KV.get(historyKey);
        if (historyStr) {
            try {
                history = JSON.parse(historyStr);
            } catch (e) {
                console.error("Failed to parse history from KV", e);
            }
        }
    }

    // 将当前用户的 prompt 加入历史记录
    history.push({
        role: "user",
        parts: [{ text: safePrompt }]
    });

    // 构建请求体
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

    // Use an AbortController to enforce a 25-second timeout
    // Cloudflare Workers (free tier) typically terminate after 30s of wall-clock time
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

        // 如果请求成功，或者是客户端错误（如 400 Bad Request），或者达到最大重试次数，则跳出循环
        if (geminiRes.ok || geminiRes.status < 500 || retries >= maxRetries) {
          break;
        }

        retries++;
        console.warn(`Gemini API returned error status ${geminiRes.status}, retrying ${retries}/${maxRetries}...`);
        // 延迟重试：1秒, 2秒, 3秒
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
          // 过滤掉 thought 部分，并合并所有文本部分
          replyText = parts
            .filter((part: any) => !part.thought)
            .map((part: any) => part.text || "")
            .join("")
            .trim();
       }
       
       if (!replyText) {
          // 检查是否被安全过滤器拦截
          const finishReason = geminiData?.candidates?.[0]?.finishReason;
          if (finishReason && finishReason !== 'STOP') {
             replyText = `抱歉，内容生成被拦截。原因: ${finishReason}`;
          } else {
             console.error('Gemini API Unexpected Response:', JSON.stringify(geminiData, null, 2));
             replyText = `抱歉，收到意外的 API 响应格式。\n响应内容: ${JSON.stringify(geminiData).substring(0, 500)}`;
          }
       }
    }

    // 保存对话记录到 KV
    if (replyText && userId && env.MEMORY_KV) {
        const MAX_HISTORY_LENGTH = 20; // 保存最近10轮对话
        history.push({
            role: "model",
            parts: [{ text: replyText }]
        });
        
        if (history.length > MAX_HISTORY_LENGTH) {
            history = history.slice(history.length - MAX_HISTORY_LENGTH);
        }
        
        const historyKey = `history_${userId}`;
        await env.MEMORY_KV.put(historyKey, JSON.stringify(history), { expirationTtl: 86400 }).catch(console.error); // 24小时过期
    }

    // Discord message limit is 2000 characters. Split text into chunks.
    const maxLength = 2000;
    const chunks: string[] = [];
    let remainingText = replyText;
    
    while (remainingText.length > 0) {
      if (remainingText.length <= maxLength) {
        chunks.push(remainingText);
        break;
      }
      
      // Try to find a newline to break at, avoiding breaking words/sentences if possible
      let breakIndex = remainingText.lastIndexOf('\n', maxLength);
      // If no newline in the first 2000 chars, or it's too early, hard break at 2000
      if (breakIndex === -1 || breakIndex < maxLength * 0.5) {
         breakIndex = maxLength;
      }
      
      chunks.push(remainingText.substring(0, breakIndex));
      remainingText = remainingText.substring(breakIndex).replace(/^\n+/, ''); // remove leading newlines
    }

    // 2. Send the first chunk to edit the deferred response
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

    // 3. Send subsequent chunks as follow-up messages
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
       errorMessage = "请求超时 (AI 服务响应时间超过25秒)。请尝试更简单的问题。";
    }
    // Send error message to Discord
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
