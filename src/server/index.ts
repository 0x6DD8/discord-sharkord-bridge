import {
  ChannelType,
  type PluginContext,
  type UnloadPluginContext,
} from "@sharkord/plugin-sdk";
import {
  ChannelType as DiscordChannelType,
  Client,
  GatewayIntentBits,
  type TextChannel,
  type Webhook,
} from "discord.js";
import type { TBridgeStatus, TPlugin } from "../types";

type SharkordAvatar = {
  name: string;
  _accessToken?: string;
  _accessTokenExpiresAt?: number;
};

type TBotContext = {
  client: Client;
  guildId: string;
  baseUrl: string;
};

let bot: TBotContext | null = null;
let lastError: string | undefined;

const webhookByChannelId = new Map<string, Webhook>();
const sharkordChannelIdByName = new Map<string, number>();

const normalizeChannelName = (name: string) => name.trim().toLowerCase();

const buildAvatarUrl = (
  ctx: PluginContext<TPlugin>,
  file: SharkordAvatar | null | undefined,
  baseUrl: string,
) => {
  if (!file || !baseUrl) {
    return undefined;
  }

  const url = new URL(`/public/${encodeURIComponent(file.name)}`, baseUrl);

  if (file._accessToken && file._accessTokenExpiresAt) {
    url.searchParams.set("accessToken", file._accessToken);
    url.searchParams.set("expires", String(file._accessTokenExpiresAt));
  }

  return url.toString();
};

const refreshChannelIndex = async (ctx: PluginContext<TPlugin>) => {
  const channels = await ctx.channels.list();

  sharkordChannelIdByName.clear();

  for (const channel of channels) {
    if (channel.isDm || channel.type !== ChannelType.TEXT) {
      continue;
    }

    sharkordChannelIdByName.set(
      normalizeChannelName(channel.name),
      channel.id,
    );
  }
};

const resolveSharkordChannelIdByName = async (
  ctx: PluginContext<TPlugin>,
  channelName: string,
): Promise<number | undefined> => {
  const key = normalizeChannelName(channelName);
  const cached = sharkordChannelIdByName.get(key);

  if (cached !== undefined) {
    return cached;
  }

  await refreshChannelIndex(ctx);

  return sharkordChannelIdByName.get(key);
};

const getOrCreateWebhook = async (
  ctx: PluginContext<TPlugin>,
  guildId: string,
  channelName: string,
): Promise<Webhook | null> => {
  if (!bot) {
    return null;
  }

  const guild =
    bot.client.guilds.cache.get(guildId) ??
    (await bot.client.guilds.fetch(guildId).catch(() => null));

  if (!guild) {
    ctx.logger.error(`Discord guild with ID ${guildId} was not found by the bot.`);
    return null;
  }

  const channel = guild.channels.cache.find(
    (ch) =>
      ch.type === DiscordChannelType.GuildText && ch.name === channelName,
  );

  if (!channel || channel.type !== DiscordChannelType.GuildText) {
    ctx.logger.error(
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
    (webhook) => webhook.owner?.id === bot?.client.user?.id,
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

const onLoad = async (ctx: PluginContext<TPlugin>) => {
  ctx.logger.log("Starting Discord-Sharkord Bridge plugin...");

  const settings = await ctx.settings.register([
    {
      key: "discord-bot-token",
      name: "Discord Bot Token",
      description: "The token for your Discord bot",
      type: "secret",
      defaultValue: "",
    },
    {
      key: "discord-guild-id",
      name: "Discord Guild ID",
      description: "The ID of the Discord guild where webhooks will be created",
      type: "string",
      defaultValue: "",
    },
    {
      key: "sharkord-public-base-url",
      name: "Sharkord Public Base URL",
      description:
        "The base URL for the Sharkord public fileserver, used to build avatar URLs. Only needed if you want to display user avatars in Discord",
      type: "string",
      defaultValue: "",
    },
  ] as const);

  const botToken = String(settings.get("discord-bot-token") ?? "");
  const guildId = String(settings.get("discord-guild-id") ?? "");
  const baseUrl = String(settings.get("sharkord-public-base-url") ?? "");

  const buildStatus = (): TBridgeStatus => ({
    configured: Boolean(botToken) && Boolean(guildId),
    connected: bot?.client.isReady() ?? false,
    guildId,
    discordUsername: bot?.client.user?.tag ?? null,
    bridgedChannels: [...sharkordChannelIdByName.keys()].sort(),
    error: lastError,
  });

  ctx.ui.enable();

  ctx.actions.register({
    name: "getStatus",
    description: "Returns the current state of the Discord bridge.",
    executes: async () => buildStatus(),
  });

  
  ctx.events.on("channel:created", () => refreshChannelIndex(ctx));
  ctx.events.on("channel:updated", () => refreshChannelIndex(ctx));
  ctx.events.on("channel:deleted", () => refreshChannelIndex(ctx));

  // Sharkord -> Discord
  ctx.events.on(
    "message:created",
    async ({ userId, channelId, textContent, pluginId }) => {

      if (pluginId === ctx.pluginId) {
        return;
      }

      if (!bot) {
        lastError = "Discord bot client is not initialized.";
        return;
      }

      const channel = await ctx.channels.get(channelId);

      if (!channel || channel.isDm || channel.type !== ChannelType.TEXT) {
        return;
      }

      const text = textContent.trim();

      if (!text) {
        return;
      }

      const user = userId !== null ? await ctx.users.get(userId) : undefined;
      const username = user?.name ?? "unknown-user";

      try {
        const webhook = await getOrCreateWebhook(ctx, bot.guildId, channel.name);

        if (!webhook) {
          return;
        }

        await webhook.send({
          content: text,
          username,
          avatarURL: buildAvatarUrl(ctx, user?.avatar, bot.baseUrl),
        });
      } catch (error) {
        lastError = `Failed to create/send Discord webhook message: ${String(error)}`;
        ctx.logger.error(lastError);
      }
    },
  );

  if (!botToken || !guildId) {
    ctx.logger.log("Discord bridge is disabled: configure a valid Discord Bot Token and Guild ID in plugin settings.");
    ctx.push.toAll(buildStatus());
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

  bot = { client, guildId, baseUrl };

  client.once("clientReady", () => {
    lastError = undefined;
    ctx.logger.log(`Discord bot connected as ${client.user?.tag ?? "unknown-user"}`);

    void refreshChannelIndex(ctx).catch(() => undefined);
    ctx.push.toAll(buildStatus());
  });

  client.on("error", (error) => {
    lastError = String(error);
    ctx.logger.error(`Discord client error: ${lastError}`);
  });

  // Discord -> Sharkord
  client.on("messageCreate", async (message) => {
    try {
      if (message.guildId !== guildId) {
        return;
      }

      if (message.author.bot || message.webhookId) {
        return;
      }

      const text = message.content?.trim();

      if (!text) {
        return;
      }

      if (message.channel.type !== DiscordChannelType.GuildText) {
        return;
      }

      const channelName = message.channel.name;
      const sharkordChannelId = await resolveSharkordChannelIdByName(
        ctx,
        channelName,
      );

      if (sharkordChannelId === undefined) {
        ctx.logger.error(`Could not find Sharkord channel ID for Discord channel name '${channelName}'.`,);
        return;
      }

      await ctx.messages.send(
        sharkordChannelId,
        `[${message.author.displayName}] <br>${text}`,
      );
    } catch (error) {
      ctx.logger.error(`Failed to bridge Discord message: ${String(error)}`);
    }
  });

  try {
    await client.login(botToken);

    ctx.logger.log("Discord bot client initialized");
  } catch (error) {
    lastError = `Failed to log in to Discord: ${String(error)}`;
    ctx.logger.error(lastError);
    client.destroy();
    bot = null;
    ctx.push.toAll(buildStatus());
  }
};

const onUnload = (ctx: UnloadPluginContext) => {
  webhookByChannelId.clear();
  sharkordChannelIdByName.clear();
  lastError = undefined;

  if (bot) {
    bot.client.destroy();
    bot = null;
  }

  ctx.logger.log("Discord-Sharkord Bridge unloaded");
};

export { onLoad, onUnload };
