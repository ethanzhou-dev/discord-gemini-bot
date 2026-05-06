import { verifyKey } from 'discord-interactions';

export interface Env {
  DISCORD_PUBLIC_KEY: string;
  DISCORD_APPLICATION_ID: string;
  GEMINI_API_KEY: string;
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
    const isValidRequest = verifyKey(
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
        const prompt = interaction.data.options?.find((opt: any) => opt.name === 'prompt')?.value;

        // Use ctx.waitUntil to process the Gemini request in the background
        // and allow the worker to return the ACK response immediately to Discord (must be < 3 seconds)
        ctx.waitUntil(handleAskCommand(prompt, interaction.token, env));
        
        // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
        return Response.json({
          type: 5,
        });
      }
    }

    return new Response('Not found', { status: 404 });
  }
};

async function handleAskCommand(prompt: string, token: string, env: Env) {
  try {
    // 1. Request Gemini API
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;
    const geminiRes = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    });

    const geminiData: any = await geminiRes.json();
    let replyText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!replyText) {
       replyText = "抱歉，我无法生成回复。 (Sorry, I couldn't generate a response.)";
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
        content: "请求 Gemini API 时发生错误。 (An error occurred while communicating with Gemini API.)"
      })
    });
  }
}
