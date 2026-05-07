const TOKEN = process.env.DISCORD_TOKEN;
const APP_ID = process.env.DISCORD_APPLICATION_ID;

if (!TOKEN || !APP_ID) {
  console.error("请设置 DISCORD_TOKEN 和 DISCORD_APPLICATION_ID 环境变量。 (Please set DISCORD_TOKEN and DISCORD_APPLICATION_ID environment variables.)");
  process.exit(1);
}

const commands = [
  {
    name: 'ask',
    description: '向 Gemini AI 提问 (Ask Gemini AI a question)',
    type: 1, // CHAT_INPUT
    options: [
      {
        name: '问题',
        description: '你的问题 (Your question)',
        type: 3, // STRING
        required: true,
      }
    ]
  },
  {
    name: 'Ask Gemini',
    type: 3, // MESSAGE
  }
];

async function registerCommands() {
  const url = `https://discord.com/api/v10/applications/${APP_ID}/commands`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bot ${TOKEN}`
    },
    body: JSON.stringify(commands)
  });

  if (response.ok) {
    console.log('✅ 斜杠命令注册成功！ (Successfully registered slash commands!)');
  } else {
    console.error('❌ 命令注册失败 (Failed to register commands)', await response.text());
  }
}

registerCommands();
