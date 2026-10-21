# Discord Sharkord Bridge

A Sharkord plugin that bridges messages between Sharkord and Discord channels
with the same name.
## Setup

Configure these plugin settings in Sharkord:

- `discord-bot-token` - the token for your Discord bot.
- `discord-guild-id` - the guild where matching channels and webhooks live.
- `sharkord-public-base-url` - optional; the base URL of the Sharkord public
  fileserver, used to build avatar URLs for Discord webhooks.

The bot needs the **Server Members**, **Message Content**, and **Manage
Webhooks** intents/permissions in the guild.


## Building

### 1. setup SDK
```bash
bun run setup
```
### 2. Build/Export
```bash
bun run build
```

The exported plugin lands in `dist/discord-sharkord-bridge/` 
