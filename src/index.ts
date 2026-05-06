import { verifyKey } from 'discord-interactions';

export interface Env {
  DISCORD_PUBLIC_KEY: string;
  DISCORD_APPLICATION_ID: string;
  GEMINI_API_KEY: string;
  // 可选配置：人设和模型
  SYSTEM_PROMPT?: string;
  GEMINI_MODEL?: string;
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

      if (commandName === 'ask') {
        const prompt = interaction.data.options?.find((opt: any) => opt.name === '问题')?.value;

        // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
        const response = Response.json({
          type: 5,
        });

        // Use ctx.waitUntil to process the Gemini request in the background
        if (prompt) {
          ctx.waitUntil(handleAskCommand(prompt, interaction.token, env));
        } else {
          ctx.waitUntil(handleAskCommand("你好", interaction.token, env)); // Default prompt if somehow empty
        }
        
        return response;
      }
    }

    return new Response('Not found', { status: 404 });
  }
};

async function handleAskCommand(prompt: string, token: string, env: Env) {
  try {
    // 1. Request Gemini API
    const model = env.GEMINI_MODEL || 'gemini-1.5-flash';
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
    
    // 确保 prompt 不为空
    const safePrompt = (prompt && prompt.trim() !== '') ? prompt : "你好";

    // 构建请求体
    const requestBody: any = {
      contents: [{ 
        parts: [{ text: safePrompt }] 
      }]
    };
    
    if (env.SYSTEM_PROMPT) {
      requestBody.system_instruction = {
        parts: [{ text: env.SYSTEM_PROMPT }]
      };
    }

    const geminiRes = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    const geminiData: any = await geminiRes.json();
    let replyText = "";
    
    if (!geminiRes.ok) {
       console.error('Gemini API Error:', JSON.stringify(geminiData, null, 2));
       const errorMsg = geminiData?.error?.message || JSON.stringify(geminiData);
       replyText = `抱歉，Gemini API 返回了错误。\n状态码: ${geminiRes.status}\n信息: ${errorMsg}`;
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

    // Discord message limit is 2000 characters
    if (replyText.length > 2000) {
        replyText = replyText.substring(0, 1997) + '...';
    }

    // 2. Send the actual generated text to edit the deferred response
    const discordUrl = `https://discord.com/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/${token}/messages/@original`;
    await fetch(discordUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: replyText
      })
    });
  } catch (e) {
    console.error(e);
    // Send error message to Discord
    const discordUrl = `https://discord.com/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/${token}/messages/@original`;
    await fetch(discordUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: "请求 Gemini API 时发生网络错误。"
      })
    });
  }
}
