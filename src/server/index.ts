import {
  type PluginContext,
} from "@sharkord/plugin-sdk";
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  type TextChannel,
  type Webhook,
} from "discord.js";

let discordClient: Client | null = null;
const webhookByChannelId = new Map<string, Webhook>();
const sharkordChannelIdByName = new Map<string, number>();

const CHANNEL_SCAN_MAX_ID = 500;
const CHANNEL_SCAN_BATCH_SIZE = 25;

let channelScanPromise: Promise<void> | null = null;

type SharkordFile = {
  name: string;
  _accessToken?: string;
  _accessTokenExpiresAt?: number;
};

type SharkordUser = {
  name: string;
  avatar?: SharkordFile | null;
};

type SharkordChannel = {
  id: number;
  name: string;
  isDm?: boolean;
};

type SharkordDataApi = {
  getChannel(channelId: number): Promise<unknown | undefined>;
  getChannels?: () => Promise<unknown[]>;
};

const normalizeChannelName = (name: string) => name.trim().toLowerCase();

const isSharkordChannel = (value: unknown): value is SharkordChannel => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<SharkordChannel>;
  return typeof candidate.id === "number" && typeof candidate.name === "string";
};

const indexChannels = (channels: unknown[]) => {
  for (const channel of channels) {
    if (!isSharkordChannel(channel) || channel.isDm) {
      continue;
    }

    sharkordChannelIdByName.set(normalizeChannelName(channel.name), channel.id);
  }
};

const scanSharkordChannelsByIdRange = async (ctx: PluginContext) => {
  const dataApi = ctx.data as SharkordDataApi;

  for (let start = 1; start <= CHANNEL_SCAN_MAX_ID; start += CHANNEL_SCAN_BATCH_SIZE) {
    const ids = Array.from(
      { length: Math.min(CHANNEL_SCAN_BATCH_SIZE, CHANNEL_SCAN_MAX_ID - start + 1) },
      (_, index) => start + index,
    );

    const channels = await Promise.all(
      ids.map((channelId) => dataApi.getChannel(channelId).catch(() => undefined)),
    );

    indexChannels(channels);
  }
};

const ensureChannelNameIndex = async (ctx: PluginContext) => {
  if (sharkordChannelIdByName.size > 0) {
    return;
  }

  if (channelScanPromise) {
    await channelScanPromise;
    return;
  }

  channelScanPromise = (async () => {
    const dataApi = ctx.data as SharkordDataApi;

    if (typeof dataApi.getChannels === "function") {
      const channels = await dataApi.getChannels().catch(() => []);
      indexChannels(channels);
      return;
    }

    await scanSharkordChannelsByIdRange(ctx);
  })();

  try {
    await channelScanPromise;
  } finally {
    channelScanPromise = null;
  }
};

const resolveSharkordChannelIdByName = async (
  ctx: PluginContext,
  channelName: string,
): Promise<number | undefined> => {
  const key = normalizeChannelName(channelName);
  const cached = sharkordChannelIdByName.get(key);
  if (cached !== undefined) {
    return cached;
  }

  await ensureChannelNameIndex(ctx);
  return sharkordChannelIdByName.get(key);
};


const buildAvatarUrl = (file: SharkordFile | null | undefined, baseUrl: string) => {
  if (!file) return undefined;

  const url = new URL(`/public/${encodeURIComponent(file.name)}`, baseUrl);

  if (file._accessToken && file._accessTokenExpiresAt) {
    url.searchParams.set("accessToken", file._accessToken);
    url.searchParams.set("expires", String(file._accessTokenExpiresAt));
  }

  return url.toString();
};


const getOrCreateWebhook = async (
  ctx: PluginContext,
  guildId: string,
  channelName: string,
): Promise<Webhook | null> => {
  if (!discordClient) {
    return null;
  }

  const guild =
    discordClient.guilds.cache.get(guildId) ??
    (await discordClient.guilds.fetch(guildId).catch(() => null));

  if (!guild) {
    ctx.log(`Discord guild with ID ${guildId} was not found by the bot.`);
    return null;
  }

  const channel = guild.channels.cache.find(
    (ch) => ch.type === ChannelType.GuildText && ch.name === channelName,
  );

  if (!channel || channel.type !== ChannelType.GuildText) {
    ctx.log(
      `Discord text channel with name ${channelName} was not found in guild ${guildId}.`,
    );
    return null;
  }

  const textChannel = channel as TextChannel;
  const cachedWebhook = webhookByChannelId.get(textChannel.id);
  if (cachedWebhook) {
    return cachedWebhook;
  }

  const existingWebhooks = await textChannel.fetchWebhooks();
  const ownedWebhook = existingWebhooks.find(
    (webhook) => webhook.owner?.id === discordClient?.user?.id,
  );

  const webhook =
    ownedWebhook ??
    (await textChannel.createWebhook({
      name: "Sharkord Bridge",
      reason: "Auto-created for Sharkord message bridge",
    }));

  webhookByChannelId.set(textChannel.id, webhook);
  return webhook;
};

const onLoad = async (ctx: PluginContext) => {
  ctx.log("Starting Discord-Sharkord Bridge plugin...");

  const settings = await ctx.settings.register([
    {
      key: "discord-bot-token",
      name: "Discord Bot Token",
      description: "The token for your Discord bot",
      type: "string",
      defaultValue: "BotTokenGoesHere",
    },
    {
      key: "discord-guild-id",
      name: "Discord Guild ID",
      description: "The ID of the Discord guild where webhooks will be created",
      type: "string",
      defaultValue: "ChangeThisToYourGuildID",
    },
    {
      key: "sharkord-public-base-url",
      name: "Sharkord Public Base URL",
      description: "The base URL for the Sharkord public fileserver, used to build avatar URLs. Only needed if you want to display user avatars in Discord",
      type: "string",
      defaultValue: "https://your-sharkord-instance.com",
    },
  ]);

  const botToken = await settings.get("discord-bot-token");
  const guildId = await settings.get("discord-guild-id");
  const sharkordBaseUrl = await settings.get("sharkord-public-base-url");
  if (!botToken || botToken === "BotTokenGoesHere") {
    ctx.log(
      "Discord bot is disabled: configure a valid Discord Bot Token in plugin settings.",
    );
    return;
  }

  if (!guildId || guildId === "ChangeThisToYourGuildID") {
    ctx.log(
      "Discord bridge is disabled: configure a valid Discord Guild ID in plugin settings.",
    );
    return;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildWebhooks,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once("ready", () => {
    ctx.log(`Discord bot connected as ${client.user?.tag ?? "unknown-user"}`);
  });

  client.on("messageCreate", async (message) => {
    if (message.guildId !== guildId) return;
    if (message.author.bot || message.webhookId) return;

    const text = message.content?.trim();
    if (!text) return;

    const channelName =
      message.channel.type === ChannelType.GuildText
        ? message.channel.name
        : undefined;
        
    if (!channelName) return;

    const sharkordChannelId = await resolveSharkordChannelIdByName(ctx, channelName);
    if (sharkordChannelId === undefined) {
      ctx.error(
        `Could not find Sharkord channel ID for Discord channel name '${channelName}'.`,
      );
      return;
    }

    await ctx.messages.send(
      sharkordChannelId,
      "[" + message.author.displayName + "] <br>" + text,
    );
  });

  await client.login(botToken);
  discordClient = client;
  ctx.log("Discord bot client initialized");
  
  ctx.events.on("message:created", async ({ userId, channelId, textContent, pluginId }) => {
    if (pluginId === ctx.pluginId) {
      return;
    }

    if (!discordClient) {
      ctx.error("Discord bot client is not initialized.");
      return;
    }


    const sharkordChannel = await ctx.data.getChannel(channelId) as SharkordChannel | undefined;
    const sharkordUser = await ctx.data.getUser(userId ?? -1) as SharkordUser | undefined;
    const sharkordUsername = sharkordUser ? sharkordUser.name : "unknown-user";

    if (sharkordChannel?.name) {
      sharkordChannelIdByName.set(
        normalizeChannelName(sharkordChannel.name),
        sharkordChannel.id,
      );
    }


    if (sharkordChannel?.isDm) {
      return;
    }

    if (sharkordChannel?.name === undefined) {
      ctx.error(`Channel with ID ${channelId} not found or has no name.`);
      return;
    }


    try {
      const webhook = await getOrCreateWebhook(ctx, guildId, sharkordChannel?.name);
      if (!webhook) {
        return;
      }

      const sharkordUserAvatar = buildAvatarUrl(sharkordUser?.avatar, sharkordBaseUrl);

      await webhook.send({
        content: textContent,
        username: `${sharkordUsername}`,
        avatarURL: sharkordUserAvatar,
      });
    } catch (error) {
      ctx.error(`Failed to create/send Discord webhook message: ${String(error)}`);
    }
    
  });
};

const onUnload = async (ctx: PluginContext) => {
  webhookByChannelId.clear();
  sharkordChannelIdByName.clear();

  if (discordClient) {
    discordClient.destroy();
    discordClient = null;
  }

  ctx.log("My Plugin unloaded");
};

export { onLoad, onUnload };
